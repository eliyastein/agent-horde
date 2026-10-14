import type { ChildProcess } from "node:child_process";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HordeTarget } from "../args.js";
import { postBoard } from "../ledger/board.js";
import { readCleanStop, readSolvedState, writeCleanStop } from "../ledger/run-signals.js";
import { recordLifecycle } from "./lifecycle.js";
import type { MemberState } from "../member.js";
import type { HordeRun } from "./types.js";
import { refreshRun, safeNotify } from "./ui.js";

/** How long stop-clean lets members wrap up before it escalates to stop-hard. */
const CLEAN_STOP_GRACE_MS = 90_000;

/** One final extension when a member is actively writing at the clean-stop deadline. */
const CLEAN_STOP_ACTIVE_GRACE_MS = Number(process.env.PI_HORDE_ACTIVE_GRACE_MS) || 15_000;

/** Extra window during stop for a live member to validate a solve landing at the wire. */
const SOLVED_STOP_MS = Number(process.env.PI_HORDE_SOLVED_STOP_MS) || 30_000;

/** Why a clean stop was requested; selects the report's stop label. */
type CleanStopLabel = "stop-clean" | "deadline" | "solved";

interface CleanStopOptions {
  graceMs?: number | undefined;
  postmortem?: boolean | undefined;
  label?: CleanStopLabel | undefined;
}

function selectedMembers(
  run: HordeRun,
  target: HordeTarget,
): { members: MemberState[]; invalid: string[] } {
  if (target.kind === "all") return { members: run.members, invalid: [] };
  const known = new Set(run.members.map((m) => m.name));
  return {
    members: run.members.filter((m) => target.names.includes(m.name)),
    invalid: target.names.filter((name) => !known.has(name)),
  };
}

/** Resolve a target, or notify and return undefined when it names unknown members. */
export function targetMembers(
  run: HordeRun,
  target: HordeTarget,
  ctx: ExtensionCommandContext,
): MemberState[] | undefined {
  const { members, invalid } = selectedMembers(run, target);
  if (invalid.length === 0) return members;
  ctx.ui.notify(`no such member: ${invalid.join(", ")}`, "error");
  return undefined;
}

function liveProc(run: HordeRun, name: string): ChildProcess | undefined {
  const proc = run.procs.get(name);
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return undefined;
  return proc;
}

export function hardStopMembers(run: HordeRun, names: string[]): void {
  for (const name of names) {
    const controller = run.controllers.get(name);
    if (controller && !controller.signal.aborted) controller.abort();
  }
}

export function stopHard(run: HordeRun, target: HordeTarget, ctx: ExtensionCommandContext): void {
  const members = targetMembers(run, target, ctx);
  if (!members) return;
  const names = members.map((m) => m.name);
  run.stopped = true;
  run.userStop = true;
  run.stopLabel = "stopped by user";
  hardStopMembers(run, names);
  void recordLifecycle(run, "stop-hard", { members: names, by: "user" });
  ctx.ui.notify(`stop-hard: terminating ${names.join(", ")}`, "warning");
}

/** Suspend (SIGSTOP) or resume (SIGCONT) the targeted live members. */
export function setPaused(
  run: HordeRun,
  target: HordeTarget,
  ctx: ExtensionCommandContext,
  paused: boolean,
): void {
  if (process.platform === "win32") {
    ctx.ui.notify("pause/resume are not supported on Windows", "error");
    return;
  }
  const members = targetMembers(run, target, ctx);
  if (!members) return;
  let changed = 0;
  for (const member of members) {
    const proc = liveProc(run, member.name);
    if (!proc || member.paused === paused) continue;
    proc.kill(paused ? "SIGSTOP" : "SIGCONT");
    member.paused = paused;
    changed++;
  }
  refreshRun(run);
  const message = paused
    ? changed > 0
      ? `paused ${changed} member(s)`
      : "no running members to pause"
    : changed > 0
      ? `resumed ${changed} member(s)`
      : "no paused members to resume";
  ctx.ui.notify(message, "info");
}

function stopLabelFor(label: CleanStopLabel): string {
  if (label === "deadline") return "stopped at deadline";
  if (label === "solved") return "stopped during solved wind-down";
  return "stopped by user";
}

/** Write the sentinel member tools read; an empty member list means the whole run. */
function writeStopSentinel(run: HordeRun, all: boolean, requested: string[]): void {
  const existing = readCleanStop(run.runDir);
  const members =
    all || (existing?.runId === run.id && existing.members.length === 0)
      ? []
      : Array.from(new Set([...(existing?.members ?? []), ...requested]));
  writeCleanStop(run.runDir, { runId: run.id, members, at: new Date().toISOString() });
}

/** Push the clean-stop deadline out once, for a reason the operator is told about. */
function holdCleanStop(
  run: HordeRun,
  members: MemberState[],
  label: CleanStopLabel,
  holdMs: number,
  message: string,
): void {
  run.cleanStopUntil = Date.now() + holdMs;
  run.cleanStopTimer = setTimeout(() => finishCleanStop(run, members, label), holdMs);
  run.cleanStopTimer.unref?.();
  safeNotify(run, message, "info");
  refreshRun(run);
}

/**
 * The clean-stop deadline: hold once for members still writing, hold once for a
 * validator of a solve that landed during wind-down, then hard-stop the rest.
 */
function finishCleanStop(run: HordeRun, members: MemberState[], label: CleanStopLabel): void {
  const now = Date.now();
  const recentlyActive = members.filter(
    (member) =>
      Boolean(liveProc(run, member.name)) &&
      member.lastActivityAt !== undefined &&
      now - member.lastActivityAt <= CLEAN_STOP_ACTIVE_GRACE_MS,
  );
  if (!run.cleanStopExtended && recentlyActive.length > 0) {
    run.cleanStopExtended = true;
    holdCleanStop(
      run,
      members,
      label,
      CLEAN_STOP_ACTIVE_GRACE_MS,
      `${label}: extending ${Math.round(CLEAN_STOP_ACTIVE_GRACE_MS / 1000)}s for active writers ` +
        recentlyActive.map((member) => member.name).join(", "),
    );
    return;
  }
  const solvedState = readSolvedState(run.runDir);
  const proposer = solvedState.proposal?.member;
  const validatorAlive =
    proposer !== undefined &&
    !solvedState.confirm &&
    !solvedState.contest &&
    members.some((member) => member.name !== proposer && Boolean(liveProc(run, member.name)));
  if (!run.solvedStopExtended && validatorAlive) {
    run.solvedStopExtended = true;
    holdCleanStop(
      run,
      members,
      label,
      SOLVED_STOP_MS,
      `${label}: holding ${Math.round(SOLVED_STOP_MS / 1000)}s for a validator of ${proposer}'s SOLVED`,
    );
    return;
  }
  run.cleanStopTimer = undefined;
  run.cleanStopUntil = undefined;
  hardStopMembers(run, run.cleanStopNames);
  void recordLifecycle(run, "stop-hard", { members: run.cleanStopNames, by: label });
  safeNotify(run, `${label} deadline reached: terminating ${run.cleanStopNames.join(", ")}`, "warning");
  refreshRun(run);
}

/** A suspended member cannot wrap up; wake the ones being cleaned up. */
function wakePaused(run: HordeRun, members: MemberState[]): void {
  if (process.platform === "win32") return;
  for (const member of members) {
    if (member.paused) {
      liveProc(run, member.name)?.kill("SIGCONT");
      member.paused = false;
    }
  }
}

/** Ask the targeted members to wrap up, with a hard stop once the grace period ends. */
export async function requestCleanStop(
  run: HordeRun,
  target: HordeTarget,
  ctx: ExtensionCommandContext,
  options: CleanStopOptions = {},
): Promise<void> {
  const label = options.label ?? "stop-clean";
  const members = targetMembers(run, target, ctx);
  if (!members) return;
  if (members.length === 0) {
    ctx.ui.notify("no running members to stop", "info");
    return;
  }
  const grace = options.graceMs ?? CLEAN_STOP_GRACE_MS;
  const all = target.kind === "all";
  const requested = members.map((m) => m.name);
  writeStopSentinel(run, all, requested);
  await recordLifecycle(run, "stop-clean", { label, members: requested, all, graceMs: grace });

  run.stopped = true;
  run.userStop = true;
  run.stopLabel = stopLabelFor(label);
  if (options.postmortem === true) run.postmortemFlag = true;
  run.cleanStopNames = all
    ? run.members.map((m) => m.name)
    : Array.from(new Set([...run.cleanStopNames, ...requested]));
  run.cleanStopUntil = Date.now() + grace;
  run.cleanStopExtended = false;
  if (run.cleanStopTimer) clearTimeout(run.cleanStopTimer);
  run.cleanStopTimer = setTimeout(() => finishCleanStop(run, members, label), grace);
  run.cleanStopTimer.unref?.();

  wakePaused(run, members);
  refreshRun(run);
  const graceSeconds = Math.round(grace / 1000);
  ctx.ui.notify(
    `${label}: ${requested.length} member(s) wrapping up, hard stop in ${graceSeconds}s`,
    "warning",
  );
  try {
    await postBoard(
      run.hordeDir,
      "parent",
      `${label} requested: ${requested.join(", ")} wrap up; hard stop in ${graceSeconds}s. ` +
        "Call 'horde list' and finish your claimed ideas.",
    );
  } catch {
    // The board notice is best effort.
  }
}
