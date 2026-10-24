import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DashboardOption, HordeRunArgs } from "../args.js";
import { resolveDashboardPort, startDashboard } from "../dashboard.js";
import { envNumber, errorMessage, oneLine } from "../format.js";
import { initHordeDir } from "../ledger/files.js";
import { resetMemberState } from "../member.js";
import type { MemberState } from "../member.js";
import { hardStopMembers, requestCleanStop } from "./controls.js";
import { finalizeRun, stopRunTimers } from "./finalize.js";
import { recordLifecycle, recordPhase } from "./lifecycle.js";
import { createRun, seedRun } from "./setup.js";
import type { RunSpec } from "./setup.js";
import { drainRepairs } from "./repair.js";
import { startCollaborationScheduler } from "./schedule.js";
import { startSolvedWatch } from "./solved.js";
import { spawnOne, startStallWatch, superviseMember } from "./supervise.js";
import type { RunLaunch } from "./supervise.js";
import { allocateSwarm, dealLayers, siblingHordes, swarmMarkdown } from "./swarm.js";
import type { SwarmLayout } from "./swarm.js";
import { noteRunFinalized, noteRunReported, writeSwarmRecord } from "./swarm-finalize.js";
import { runPlanner } from "./synthesis.js";
import { activeRuns, finalizingRuns, hordeLabel } from "./types.js";
import type { HordeRun, HordeState, Swarm } from "./types.js";
import { mountWidget, safeNotify, safeNotifyUi, unmountWidget } from "./ui.js";

/** How long the canary preflight waits for the first token before declaring failure. */
const CANARY_TIMEOUT_MS = Number(process.env.PI_HORDE_CANARY_MS) || 60_000;

/** Pause between one horde's launch and the next, so H canaries do not hit the provider at once. */
const SWARM_STAGGER_MS = envNumber("PI_HORDE_SWARM_STAGGER_MS", 5_000);

type CanaryOutcome = "output" | "exit" | "timeout";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function closeDashboard(state: HordeState): void {
  const server = state.dashboard;
  state.dashboard = undefined;
  if (server) void server.close();
}

/**
 * Reconcile the dashboard server with the launch flag: start it, reuse it, or close it.
 * Returns false when the flag asked for a server that could not be started.
 */
async function ensureDashboard(
  state: HordeState,
  ctx: ExtensionCommandContext,
  hordeDir: string,
  option: DashboardOption | undefined,
): Promise<boolean> {
  if (!option) {
    if (state.dashboard) {
      closeDashboard(state);
      ctx.ui.notify("dashboard closed (run started without --dashboard)", "info");
    }
    return true;
  }
  if (state.dashboard) return true;
  try {
    state.dashboard = await startDashboard({
      port: resolveDashboardPort(option.port),
      source: {
        hordeDir,
        getActive: () => (state.active ? activeRuns(state.active) : []),
        getFinalizing: () => [
          ...(state.active ? finalizingRuns(state.active) : []),
          ...(state.finalizing ? finalizingRuns(state.finalizing) : []),
        ],
        getSwarm: () => state.active ?? state.finalizing,
      },
      onError: (error) => {
        state.dashboard = undefined;
        safeNotifyUi(ctx, `dashboard error: ${error.message}; the run continues`, "error");
      },
    });
    return true;
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
    return false;
  }
}

/** Clean-stop the run once PI_HORDE_MAX_MINUTES elapses, when that is set. */
function startDeadline(run: HordeRun, ctx: ExtensionCommandContext): void {
  const deadlineMinutes = Number(process.env.PI_HORDE_MAX_MINUTES) || 0;
  if (deadlineMinutes <= 0) return;
  run.deadlineTimer = setTimeout(() => {
    run.deadlineTimer = undefined;
    if (run.stopped) return;
    void requestCleanStop(run, { kind: "all" }, ctx, { postmortem: false, label: "deadline" });
  }, deadlineMinutes * 60_000);
  run.deadlineTimer.unref?.();
}

/** Spawn the canary and wait for its first output, its exit, or the timeout. */
async function attemptCanary(
  launch: RunLaunch,
  member: MemberState,
  spawns: Promise<void>[],
): Promise<CanaryOutcome> {
  let markFirstOutput: () => void = () => {};
  const firstOutput = new Promise<void>((resolve) => {
    markFirstOutput = resolve;
  });
  const promise = spawnOne(launch, member, markFirstOutput);
  spawns.push(promise);
  // Cancellable timeout: leaving it pending after another branch wins keeps
  // the event loop alive for the full CANARY_TIMEOUT_MS after the run ends.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), CANARY_TIMEOUT_MS);
    timer.unref?.();
  });
  const outcome = await Promise.race([
    firstOutput.then(() => "output" as const),
    promise.then(() => "exit" as const),
    timedOut,
  ]);
  if (timer) clearTimeout(timer);
  if (outcome !== "output") {
    hardStopMembers(launch.run, [member.name]);
    // Let the process actually die before a retry reuses this member state.
    await Promise.race([promise, sleep(8_000)]);
  }
  return outcome;
}

/** Run the canary, retrying once, and record the result on the run. */
async function runCanary(launch: RunLaunch, spawns: Promise<void>[]): Promise<CanaryOutcome> {
  const { run, ctx } = launch;
  const canary = run.members[0]!;
  ctx.ui.notify(`horde ${run.id}: canary preflight (${canary.name}) before fan-out`, "info");
  let outcome = await attemptCanary(launch, canary, spawns);
  if (outcome !== "output" && !run.stopped) {
    ctx.ui.notify(`horde ${run.id}: canary produced no output; retrying once`, "warning");
    resetMemberState(canary);
    await sleep(3_000);
    if (!run.stopped) outcome = await attemptCanary(launch, canary, spawns);
  }
  // Label the canary even when a stop arrived during preflight, so the
  // provider failure that caused the stop is visible in the diagnosis.
  if (outcome === "output") {
    run.canary = "ok";
  } else {
    run.canary = "failed";
    run.canaryError =
      outcome === "timeout"
        ? `no output within ${Math.round(CANARY_TIMEOUT_MS / 1000)}s (after retry)`
        : (canary.error ?? `exited with cause ${canary.endCause ?? "unknown"} (after retry)`);
  }
  return outcome;
}

/**
 * Preflight: run one canary member first and only fan out once it has
 * produced output. A dead provider then costs one member instead of N.
 * One retry distinguishes a flaky process from a dead provider.
 */
async function preflightAndFanOut(launch: RunLaunch): Promise<void> {
  const { state, swarm, run, ctx } = launch;
  if (run.stopped) {
    // A stop arrived while this horde waited its turn: nothing to spawn, finalize now.
    await finalizeRun(state, swarm, run);
    return;
  }
  const spawns: Promise<void>[] = [];
  const outcome = await runCanary(launch, spawns);
  if (run.stopped) {
    // A stop arrived during preflight: do not fan out, finalize now.
    await Promise.all(spawns);
    await finalizeRun(state, swarm, run);
    return;
  }
  if (outcome === "output") {
    // The canary's raw spawn promise is already in `spawns`; supervising it
    // too keeps the run alive through its resets.
    spawns.push(superviseMember(launch, run.members[0]!, spawns[spawns.length - 1]!));
    for (const member of run.members.slice(1)) {
      spawns.push(superviseMember(launch, member, spawnOne(launch, member)));
    }
    startStallWatch(run);
    startCollaborationScheduler(launch);
    ctx.ui.notify(
      `horde ${run.id}: canary ok, starting ${run.members.length - 1} more member(s)`,
      "info",
    );
  } else {
    run.stopped = true;
    ctx.ui.notify(`horde ${run.id}: canary failed (${run.canaryError}); not fanning out`, "error");
  }
  await Promise.all(spawns);
  await recordPhase(run, "discovery", "end");
  // The drain schedules with every member eligible; the discovery pass would only see live ones.
  if (run.scheduleTimer) clearInterval(run.scheduleTimer);
  run.scheduleTimer = undefined;
  await drainRepairs(launch);
  await finalizeRun(state, swarm, run);
}

/** The hordes' workstreams and plans: dealt layers, the planner's slices, or nothing for one horde. */
interface Partition {
  slices: string[] | undefined;
  /** Per-horde plan layers, indexed by horde - 1. */
  plans: Array<string[] | undefined>;
}

/** Note the planner's failure where the dashboard and the operator can find it. */
function writeNotStarted(layout: SwarmLayout, reason: string): void {
  if (!layout.dir) return;
  fs.writeFileSync(path.join(layout.dir, "SWARM.md"), `# Swarm ${layout.id}\n\nNot started: ${reason}\n`, "utf-8");
}

/**
 * Decide what each horde works on. `plan` layers go round-robin to the hordes and each horde
 * runs its share as its own plan; a plain prompt is split by the planner helper, and a planner
 * that cannot produce H distinct workstreams stops the launch rather than running H hordes on
 * one slice.
 */
async function partitionTask(
  state: HordeState,
  ctx: ExtensionCommandContext,
  parsed: HordeRunArgs,
  layout: SwarmLayout,
): Promise<Partition | undefined> {
  if (parsed.hordes === 1) return { slices: undefined, plans: [parsed.plan] };
  if (parsed.plan) {
    const dealt = dealLayers(parsed.plan, parsed.hordes);
    return { slices: dealt.map((layers) => layers.join("; ")), plans: dealt };
  }
  ctx.ui.notify(`swarm ${layout.id}: planner is partitioning the task into ${parsed.hordes} workstreams`, "info");
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const result = await runPlanner(state, { dir: layout.dir!, cwd: ctx.cwd, model, prompt: parsed.prompt, hordes: parsed.hordes });
  if ("error" in result) {
    writeNotStarted(layout, result.error);
    ctx.ui.notify(`swarm ${layout.id} not started: ${result.error}`, "error");
    return undefined;
  }
  return { slices: result.slices, plans: Array.from({ length: parsed.hordes }, () => undefined) };
}

function buildSwarm(
  ctx: ExtensionCommandContext,
  parsed: HordeRunArgs,
  layout: SwarmLayout,
  partition: Partition,
  dashboardUrl: string | undefined,
): { swarm: Swarm; launches: Array<{ run: HordeRun; roles: string[] }> } {
  const launches = layout.runIds.map((id, index) => {
    const spec: RunSpec = {
      id,
      hordeDir: layout.hordeDirs[index]!,
      runDir: layout.runDirs[index]!,
      horde: index + 1,
      hordes: parsed.hordes,
      swarmId: layout.id,
      slice: partition.slices?.[index],
      plan: partition.plans[index],
      siblings: siblingHordes(layout, partition.slices, index + 1),
    };
    return createRun(ctx, parsed, spec, dashboardUrl);
  });
  const swarm: Swarm = {
    id: layout.id,
    dir: layout.dir,
    hordeDir: layout.hordeDirs.length === 1 ? layout.hordeDirs[0]! : path.resolve(layout.dir!, "..", ".."),
    cwd: ctx.cwd,
    prompt: parsed.prompt,
    hordes: parsed.hordes,
    count: parsed.count,
    startedAt: Date.now(),
    runs: launches.map((launch) => launch.run),
    plan: parsed.plan,
    partition: partition.slices,
    untilStop: parsed.untilStop === true ? true : undefined,
    dashboardUrl,
  };
  return { swarm, launches };
}

/** Seed one horde's ledgers and record its start; throws on a ledger failure. */
async function seedHorde(swarm: Swarm, run: HordeRun, roles: string[]): Promise<void> {
  await seedRun(run);
  await recordLifecycle(run, "run-start", {
    count: run.count, model: run.model, verifier: run.verifier, plan: run.plan, untilStop: run.untilStop,
    roles: roles.map((role) => oneLine(role, 120)), dashboardUrl: run.dashboardUrl,
    ...(swarm.hordes > 1 ? { swarm: swarm.id, horde: run.horde, hordes: swarm.hordes, slice: run.slice } : {}),
  });
  await recordPhase(run, "discovery", "start");
}

function announceStart(ctx: ExtensionCommandContext, swarm: Swarm): void {
  if (swarm.hordes === 1) {
    const run = swarm.runs[0]!;
    const plural = run.count === 1 ? "" : "s";
    ctx.ui.notify(`horde ${run.id} started with ${run.count} member${plural} in ${run.hordeDir}`, "info");
    if (run.dashboardUrl) ctx.ui.notify(`horde ${run.id} dashboard: ${run.dashboardUrl}runs/${run.id}`, "info");
    return;
  }
  ctx.ui.notify(
    `swarm ${swarm.id} started: ${swarm.hordes} hordes of ${swarm.count} members in ${swarm.dir}, ` +
      `${Math.round(SWARM_STAGGER_MS / 1000)}s apart`,
    "info",
  );
  for (const [index, slice] of (swarm.partition ?? []).entries()) {
    ctx.ui.notify(`${hordeLabel(index + 1)}: ${oneLine(slice, 160)}`, "info");
  }
  if (swarm.dashboardUrl) ctx.ui.notify(`swarm ${swarm.id} dashboard: ${swarm.dashboardUrl}swarms/${swarm.id}`, "info");
}

/** Start the hordes' preflights a few seconds apart; a stop during the wait is honoured. */
async function staggerLaunches(state: HordeState, launches: RunLaunch[]): Promise<void> {
  for (const [index, launch] of launches.entries()) {
    if (index > 0 && !state.disposed) await sleep(SWARM_STAGGER_MS);
    if (state.disposed) return;
    void preflightAndFanOut(launch).catch((error) => {
      safeNotify(launch.run, `horde ${launch.run.id} failed: ${errorMessage(error)}`, "error");
      // The horde is down for good; let the swarm account for it so the slot and widget free.
      noteRunReported(state, launch.swarm, launch.run);
      void noteRunFinalized(state, launch.swarm, launch.run);
    });
  }
}

async function launchSwarm(
  state: HordeState,
  ctx: ExtensionCommandContext,
  parsed: HordeRunArgs,
  hordeDir: string,
): Promise<void> {
  const layout = allocateSwarm(hordeDir, parsed.hordes, Date.now());
  const partition = await partitionTask(state, ctx, parsed, layout);
  if (!partition || state.disposed) return;
  const { swarm, launches } = buildSwarm(ctx, parsed, layout, partition, state.dashboard?.url);
  // Claim the slot synchronously, before the first await, so a second
  // /agent-horde invocation in the same tick sees `active` and is refused.
  state.active = swarm;
  if (ctx.hasUI) mountWidget(swarm, ctx.ui);
  for (const run of swarm.runs) {
    startDeadline(run, ctx);
    startSolvedWatch(run, ctx);
  }
  try {
    if (swarm.dir) {
      fs.writeFileSync(path.join(swarm.dir, "SWARM.md"), swarmMarkdown(swarm), "utf-8");
      writeSwarmRecord(swarm);
    }
    for (const { run, roles } of launches) await seedHorde(swarm, run, roles);
  } catch (error) {
    for (const run of swarm.runs) stopRunTimers(run);
    unmountWidget(swarm);
    if (state.active === swarm) state.active = undefined;
    ctx.ui.notify(`horde ${swarm.id} failed to start: ${errorMessage(error)}`, "error");
    return;
  }
  void staggerLaunches(state, launches.map(({ run, roles }) => ({ state, swarm, run, ctx, roles })));
  announceStart(ctx, swarm);
}

export async function startSwarm(
  state: HordeState,
  ctx: ExtensionCommandContext,
  parsed: HordeRunArgs,
): Promise<void> {
  state.starting = true;
  try {
    const hordeDir = initHordeDir(ctx.cwd);
    if (!(await ensureDashboard(state, ctx, hordeDir, parsed.dashboard))) return;
    await launchSwarm(state, ctx, parsed, hordeDir);
  } finally {
    state.starting = false;
  }
}
