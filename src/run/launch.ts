import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DashboardOption, HordeRunArgs } from "../args.js";
import { resolveDashboardPort, startDashboard } from "../dashboard.js";
import { errorMessage, oneLine } from "../format.js";
import { initHordeDir } from "../ledger/files.js";
import { resetMemberState } from "../member.js";
import type { MemberState } from "../member.js";
import { hardStopMembers, requestCleanStop } from "./controls.js";
import { finalizeRun, stopRunTimers } from "./finalize.js";
import { recordLifecycle, recordPhase } from "./lifecycle.js";
import { createRun, seedRun } from "./setup.js";
import { drainRepairs } from "./repair.js";
import { startCollaborationScheduler } from "./schedule.js";
import { startSolvedWatch } from "./solved.js";
import { spawnOne, startStallWatch, superviseMember } from "./supervise.js";
import type { RunLaunch } from "./supervise.js";
import type { HordeRun, HordeState } from "./types.js";
import { mountWidget, safeNotify, safeNotifyUi, unmountWidget } from "./ui.js";

/** How long the canary preflight waits for the first token before declaring failure. */
const CANARY_TIMEOUT_MS = Number(process.env.PI_HORDE_CANARY_MS) || 60_000;

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
      source: { hordeDir, getActive: () => state.active, getFinalizing: () => state.finalizing },
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
  const { state, run, ctx } = launch;
  const spawns: Promise<void>[] = [];
  const outcome = await runCanary(launch, spawns);
  if (run.stopped) {
    // A stop arrived during preflight: do not fan out, finalize now.
    await Promise.all(spawns);
    await finalizeRun(state, run);
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
  await finalizeRun(state, run);
}

async function launchRun(
  state: HordeState,
  ctx: ExtensionCommandContext,
  parsed: HordeRunArgs,
  hordeDir: string,
): Promise<void> {
  const { run, roles } = createRun(ctx, parsed, hordeDir, state.dashboard?.url);
  // Claim the run synchronously, before the first await, so a second
  // /agent-horde invocation in the same tick sees `active` and is refused.
  state.active = run;
  if (ctx.hasUI) mountWidget(run, ctx.ui);
  startDeadline(run, ctx);
  startSolvedWatch(run, ctx);
  try {
    await seedRun(run);
    await recordLifecycle(run, "run-start", {
      count: run.count, model: run.model, verifier: run.verifier, plan: run.plan,
      roles: roles.map((role) => oneLine(role, 120)), dashboardUrl: run.dashboardUrl,
    });
    await recordPhase(run, "discovery", "start");
  } catch (error) {
    stopRunTimers(run);
    unmountWidget(run);
    if (state.active === run) state.active = undefined;
    ctx.ui.notify(`horde ${run.id} failed to start: ${errorMessage(error)}`, "error");
    return;
  }
  void preflightAndFanOut({ state, run, ctx, roles }).catch((error) => {
    safeNotify(run, `horde ${run.id} failed: ${errorMessage(error)}`, "error");
    if (state.active === run) state.active = undefined;
  });
  const plural = run.count === 1 ? "" : "s";
  ctx.ui.notify(`horde ${run.id} started with ${run.count} member${plural} in ${hordeDir}`, "info");
  if (run.dashboardUrl) {
    ctx.ui.notify(`horde ${run.id} dashboard: ${run.dashboardUrl}runs/${run.id}`, "info");
  }
}

export async function startRun(
  state: HordeState,
  ctx: ExtensionCommandContext,
  parsed: HordeRunArgs,
): Promise<void> {
  state.starting = true;
  try {
    const hordeDir = initHordeDir(ctx.cwd);
    if (!(await ensureDashboard(state, ctx, hordeDir, parsed.dashboard))) return;
    await launchRun(state, ctx, parsed, hordeDir);
  } finally {
    state.starting = false;
  }
}
