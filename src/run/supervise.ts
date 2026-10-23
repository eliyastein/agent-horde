import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { envNumber, errorMessage } from "../format.js";
import { postBoard } from "../ledger/board.js";
import { pendingReviewsForMember } from "../ledger/findings.js";
import { reconcileOwnedIdeas } from "../ledger/ideas.js";
import { cleanStopRequestedFor, clearHeartbeat, readHeartbeat } from "../ledger/run-signals.js";
import { resetMemberState, spawnMember } from "../member.js";
import type { MemberState } from "../member.js";
import { hardStopMembers } from "./controls.js";
import { recordLifecycle } from "./lifecycle.js";
import type { HordeRun, HordeState } from "./types.js";
import { refreshRun, safeNotify } from "./ui.js";

/** A running member with no ledger write for this long is reset; 0 disables. */
const STALL_MS = envNumber("PI_HORDE_STALL_MS", 1_800_000);

/** Fresh-context resets allowed per member before its exit is left alone. */
const RESET_CAP = envNumber("PI_HORDE_RESET_CAP", 2);

/** Member exits that a fresh session may recover from; a user stop is never one. */
const RESETTABLE_CAUSES = new Set(["model_error", "no_output", "exit_nonzero"]);

/**
 * An `--until-stop` session that finished sooner than this is held back until it has been this
 * long since it started, so a member that keeps finding nothing to do cannot spin through
 * sessions, each paying the full prompt for nothing.
 */
const CONTINUE_COOLDOWN_MS = envNumber("PI_HORDE_CONTINUE_COOLDOWN_MS", 60_000);

const CONTINUE_REASON = "until-stop: earlier session finished";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** What spawning and supervising a run's members needs beyond the run itself. */
export interface RunLaunch {
  state: HordeState;
  run: HordeRun;
  ctx: ExtensionCommandContext;
  /** Per-member role instruction, indexed by member index - 1. */
  roles: string[];
}

/** Start one member process; resolves when it exits. */
export async function spawnOne(
  launch: RunLaunch,
  member: MemberState,
  onFirstOutput?: () => void,
  onProgress?: () => void,
): Promise<void> {
  const { run, ctx } = launch;
  const controller = new AbortController();
  run.controllers.set(member.name, controller);
  const onMasterAbort = (): void => controller.abort();
  run.controller.signal.addEventListener("abort", onMasterAbort);
  member.attempt ??= randomUUID();
  const role = launch.roles[member.index - 1];
  await recordLifecycle(run, "member-spawn", {
    member: member.name, attempt: member.attempt, role: role || undefined,
    resets: member.resets ?? 0, repairs: member.repairs ?? 0,
  });
  await spawnMember({
    member,
    run,
    cwd: ctx.cwd,
    model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    thinkingLevel: ctx.thinkingLevel,
    approve: ctx.isProjectTrusted(),
    signal: controller.signal,
    role: launch.roles[member.index - 1],
    onChange: () => { onProgress?.(); refreshRun(run); },
    onSpawn: (proc) => run.procs.set(member.name, proc),
    onExit: () => {
      run.controller.signal.removeEventListener("abort", onMasterAbort);
      run.controllers.delete(member.name);
      run.procs.delete(member.name);
    },
    onFirstOutput,
  });
  await recordLifecycle(run, "member-exit", {
    member: member.name, attempt: member.attempt, status: member.status, endCause: member.endCause,
    exitCode: member.exitCode, turns: member.turns, toolCalls: member.toolCalls,
    tokens: member.usage.input + member.usage.output, partial: member.partial === true,
  });
}

/**
 * Why a member's exit should be answered with a fresh session, or undefined to
 * let it stay down. A user stop, a solve, a failed canary, or a pending clean
 * stop all mean the run is ending; the cap keeps a broken provider from being
 * retried forever.
 */
/**
 * A verifier that closes its session with high-importance findings by other members unreviewed
 * has not done its job, whatever its summary says. Its exit is answered with a fresh session
 * that is told which F# it owes, within the same reset cap as a crash.
 */
export function verificationBacklog(run: HordeRun, member: MemberState): string | undefined {
  if (member.name !== run.verifier || member.endCause !== "completed") return undefined;
  try {
    const owed = pendingReviewsForMember(run.hordeDir, run.id, member.name)
      .filter((finding) => ["critical", "high"].includes((finding.importance ?? "").toLowerCase()));
    if (!owed.length) return undefined;
    return `verification backlog: ${owed.map((finding) => `F${finding.id}`).join(", ")} unreviewed at close`;
  } catch {
    return undefined;
  }
}

function resetReasonForExit(launch: RunLaunch, member: MemberState): string | undefined {
  const { state, run } = launch;
  if (state.disposed || run.stopped || run.userStop || run.canary !== "ok") return undefined;
  // A pending proposal means the run is about to end, unless it runs until stopped.
  if (run.solved && !run.untilStop) return undefined;
  if (cleanStopRequestedFor(run.hordeDir, run.id, member.name)) return undefined;
  const reason =
    member.resetPending ??
    (RESETTABLE_CAUSES.has(member.endCause ?? "") ? member.endCause : undefined) ??
    verificationBacklog(run, member);
  if (!reason) return run.untilStop && member.endCause === "completed" ? CONTINUE_REASON : undefined;
  if ((member.resets ?? 0) >= RESET_CAP) {
    fs.appendFileSync(
      path.join(run.runDir, `${member.name}.log`),
      `[horde] reset cap reached (${reason})\n`,
    );
    return undefined;
  }
  return reason;
}

/** Release the member's ideas and tell the board a fresh session replaces it. */
async function releaseForReset(
  run: HordeRun,
  member: MemberState,
  reason: string,
): Promise<{ released: number[]; closed: number[] }> {
  let released: number[] = [];
  let closed: number[] = [];
  try {
    const result = await reconcileOwnedIdeas(run.hordeDir, run.id, [member.name]);
    released = result.released;
    closed = result.closed.map((item) => item.id);
    const releasedText = released.map((id) => `#${id}`).join(", ") || "none";
    const closedText =
      result.closed.map((item) => `#${item.id} (F${item.findingId})`).join(", ") || "none";
    const head = reason === CONTINUE_REASON
      ? `${member.name} finished and continues in a fresh session (${run.id} runs until stopped)`
      : `reset ${member.name} (${reason})`;
    await postBoard(
      run.hordeDir,
      "parent",
      `${head}: released ${releasedText}; closed ${closedText}. ` +
        `A fresh session of ${member.name} starts now; earlier claims by ${member.name} ` +
        "are void.",
    );
  } catch (error) {
    safeNotify(
      run,
      `horde ${run.id}: reset of ${member.name} could not reconcile ideas (${errorMessage(error)})`,
      "error",
    );
  }
  return { released, closed };
}

/**
 * Replace a dead or stalled member with a fresh-context session of the same
 * name. Runs only after the old process has closed, so the ledger reconcile
 * never races a live writer.
 */
async function performReset(run: HordeRun, member: MemberState, reason: string): Promise<void> {
  member.resets = (member.resets ?? 0) + 1;
  fs.appendFileSync(
    path.join(run.runDir, `${member.name}.log`),
    `[horde] reset ${member.resets}: ${reason}\n`,
  );
  const { released, closed } = await releaseForReset(run, member, reason);
  run.resets.push({
    member: member.name,
    reason,
    at: Date.now(),
    released,
    closed,
    turns: member.turns,
    toolCalls: member.toolCalls,
    tokens: member.usage.input + member.usage.output,
  });
  await recordLifecycle(run, "member-reset", { member: member.name, reason, released, closed, resets: member.resets });
  member.resetNote =
    `You replace an earlier session of ${member.name} that was reset for ${reason}; ` +
    "its ideas were released. Read BOARD.md and FINDINGS.md before claiming." +
    (reason.startsWith("verification backlog") ? " Review the findings named above, with any verdict and an honest unchecked scope, before anything else." : "");
  clearHeartbeat(run.runDir, member.name);
  resetMemberState(member);
  safeNotify(run, `horde ${run.id}: reset ${member.name} (${reason})`, "warning");
  refreshRun(run);
}

/**
 * `--until-stop`: a member that finished its session gets a fresh one. Not a recovery, so it
 * counts against no cap and is not a reset in the report; the cooldown keeps a member that
 * finds nothing to do from spinning.
 */
async function performContinue(run: HordeRun, member: MemberState): Promise<boolean> {
  const elapsed = Date.now() - member.startedAt;
  if (elapsed < CONTINUE_COOLDOWN_MS) await sleep(CONTINUE_COOLDOWN_MS - elapsed);
  // A stop during the cooldown leaves the member as it ended: finished, not killed.
  if (run.stopped) return false;
  member.continuations = (member.continuations ?? 0) + 1;
  fs.appendFileSync(
    path.join(run.runDir, `${member.name}.log`),
    `[horde] continue ${member.continuations}: ${CONTINUE_REASON}\n`,
  );
  const { released, closed } = await releaseForReset(run, member, CONTINUE_REASON);
  await recordLifecycle(run, "member-continue", { member: member.name, released, closed, continuations: member.continuations });
  member.resetNote =
    `You are a fresh session of ${member.name}; its earlier session finished and its claims were released. ` +
    "Read BOARD.md, FINDINGS.md and ANSWER.md if present, then add ideas that extend, stress-test, or deepen the work, claim them, and pursue them.";
  clearHeartbeat(run.runDir, member.name);
  resetMemberState(member);
  safeNotify(run, `horde ${run.id}: ${member.name} finished; continuing in a fresh session`, "info");
  refreshRun(run);
  return true;
}

/**
 * Resolves only when the member is down for good, so the fan-out's
 * Promise.all cannot finalize the run while a replacement is running.
 */
export async function superviseMember(
  launch: RunLaunch,
  member: MemberState,
  first: Promise<void>,
): Promise<void> {
  const { state, run } = launch;
  let exited = first;
  for (;;) {
    await exited;
    const reason = resetReasonForExit(launch, member);
    if (!reason || state.disposed) return;
    if (reason === CONTINUE_REASON) {
      if (!(await performContinue(run, member))) return;
    } else {
      await performReset(run, member, reason);
    }
    if (run.stopped || state.disposed) {
      // A stop landed during the reset: leave the member down, not "starting".
      member.status = "stopped";
      member.endCause = "killed";
      member.endedAt = Date.now();
      return;
    }
    exited = spawnOne(launch, member);
  }
}

/**
 * A running member that has not written a ledger for STALL_MS is drifting or
 * hung. Mark it and kill it; the supervise loop turns the kill into a reset.
 */
function checkStalls(run: HordeRun): void {
  if (run.stopped || (run.solved && !run.untilStop)) return;
  const now = Date.now();
  for (const member of run.members) {
    if (member.status !== "running" || member.paused || member.resetPending) continue;
    if ((member.resets ?? 0) >= RESET_CAP) continue;
    const last = readHeartbeat(run.runDir, member.name) ?? member.startedAt;
    if (now - last <= STALL_MS) continue;
    const minutes = Math.round((now - last) / 60_000);
    member.resetPending = `stalled: no ledger write for ${minutes}m`;
    hardStopMembers(run, [member.name]);
  }
}

export function startStallWatch(run: HordeRun): void {
  if (STALL_MS <= 0) return;
  run.stallTimer = setInterval(() => checkStalls(run), Math.min(30_000, Math.max(250, STALL_MS / 4)));
  run.stallTimer.unref?.();
}
