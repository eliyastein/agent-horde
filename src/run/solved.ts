import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { oneLine } from "../format.js";
import { loadCollaborationReport } from "../collaboration-report.js";
import { openMessages } from "../ledger/collaboration.js";
import { postBoard } from "../ledger/board.js";
import { unverifiedFindings } from "../ledger/findings.js";
import { listIdeas } from "../ledger/ideas.js";
import { archiveSolved, clearCleanStop, clearSolved, readSolvedState, resolveSolvedState } from "../ledger/run-signals.js";
import type { SolvedSignal } from "../ledger/run-signals.js";
import { requestCleanStop } from "./controls.js";
import { recordLifecycle } from "./lifecycle.js";
import type { HordeRun } from "./types.js";
import { refreshRun, safeNotify } from "./ui.js";

/** How long a SOLVED proposal waits for a second member to validate it before it commits. */
const SOLVED_CONFIRM_MS = Number(process.env.PI_HORDE_SOLVED_CONFIRM_MS) || 120_000;

const SOLVED_POLL_MS = 3_000;

/** Ideas this run still owes before a solve may wind it down. */
function unresolvedCoverageIdeas(run: HordeRun): number[] {
  const memberNames = new Set(run.members.map((member) => member.name));
  return listIdeas(run.hordeDir)
    .filter(
      (idea) =>
        (idea.id > run.startIdeaId && (idea.mark === " " || idea.mark === "~")) ||
        (idea.mark === "~" && Boolean(idea.owner && memberNames.has(idea.owner))),
    )
    .map((idea) => idea.id);
}

function adoptProposal(run: HordeRun, proposal: SolvedSignal): void {
  run.solved = proposal;
  run.solvedValidatedBy = undefined;
  run.solvedCommitted = false;
  run.solvedContested = false;
  run.solvedVerificationNotice = undefined;
  void recordLifecycle(run, "solved-proposed", { member: proposal.member, text: oneLine(proposal.text, 200) });
  safeNotify(run, `horde ${run.id}: ${proposal.member} proposed the goal solved`, "info");
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED proposed by ${proposal.member}: ${oneLine(proposal.text, 200)}. ` +
      `Another member must validate with 'horde confirm-solved' or refute it with 'horde contest-solved'.`,
  );
  refreshRun(run);
}

function dropContested(run: HordeRun, contest: SolvedSignal): void {
  safeNotify(run, `horde ${run.id}: solved proposal contested by ${contest.member}`, "warning");
  void recordLifecycle(run, "solved-contested", { member: contest.member, text: oneLine(contest.text, 200) });
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED proposal contested by ${contest.member}: ${contest.text}. Work continues.`,
  );
  archiveSolved(run.runDir);
  clearSolved(run.runDir);
  if (!run.stopped) clearCleanStop(run.runDir);
  run.solved = undefined;
  run.solvedValidatedBy = undefined;
  run.solvedCommitted = false;
  run.solvedCoverageNotice = undefined;
  run.solvedVerificationNotice = undefined;
  run.solvedContested = true;
  refreshRun(run);
}

/**
 * Coverage is structural: a run that created ideas must close them before a
 * solve winds it down, regardless of the prompt's wording. A run that created
 * no ideas has no unresolved coverage, so this is a no-op for simple answers.
 */
function coveragePending(run: HordeRun, validator: string | undefined): boolean {
  let unresolved: number[] = [];
  try {
    unresolved = unresolvedCoverageIdeas(run);
  } catch {
    // A missing ideas ledger is reported at finalize; do not invent coverage here.
    unresolved = [-1];
  }
  if (unresolved.length === 0) return false;
  if (validator && !run.solvedCoverageNotice) {
    run.solvedCoverageNotice = true;
    const ids = unresolved.filter((id) => id >= 0).map((id) => `#${id}`).join(", ");
    safeNotify(run, `horde ${run.id}: solution validated, waiting for coverage`, "info");
    void postBoard(
      run.hordeDir,
      "parent",
      `SOLVED validated by ${validator}, but this run still has unresolved coverage` +
        `${ids ? `: ${ids}` : "."} Continue work; a finding does not complete the task.`,
    );
  }
  return true;
}

/**
 * Verification debt is a stop condition. A validated answer does not settle
 * findings nobody reproduced, so hold wind-down while another live member
 * could still verify them, unless the operator waives the requirement.
 */
function verificationPending(run: HordeRun, othersRunning: boolean): boolean {
  const allowUnverified =
    process.env.PI_HORDE_ALLOW_UNVERIFIED === "1" ||
    process.env.PI_HORDE_ALLOW_UNVERIFIED === "true";
  const pending = unverifiedFindings(run.hordeDir, run.id);
  if (pending.length === 0 || !othersRunning || allowUnverified) return false;
  if (!run.solvedVerificationNotice) {
    run.solvedVerificationNotice = true;
    const ids = pending.map((finding) => `F${finding.id}`).join(", ");
    safeNotify(
      run,
      `horde ${run.id}: solved pending verification of ${pending.length} finding(s)`,
      "info",
    );
    void postBoard(
      run.hordeDir,
      "parent",
      `SOLVED is pending, but ${pending.length} finding(s) have no independent ` +
        `reproduction: ${ids}. Show the verifier the pending queue; set ` +
        `PI_HORDE_ALLOW_UNVERIFIED=1 to accept them unverified.`,
    );
  }
  return true;
}

function commitSolved(
  run: HordeRun,
  ctx: ExtensionCommandContext,
  validator: string | undefined,
): void {
  run.solvedValidatedBy = validator;
  run.solvedCommitted = true;
  void recordLifecycle(run, "solved-validated", { validator });
  safeNotify(
    run,
    validator
      ? `horde ${run.id}: solved validated by ${validator}`
      : `horde ${run.id}: solved committed without a separate validator`,
    validator ? "info" : "warning",
  );
  void postBoard(
    run.hordeDir,
    "parent",
    validator
      ? `SOLVED validated by ${validator}; winding down.`
      : "SOLVED committed without a separate validator; winding down.",
  );
  void requestCleanStop(run, { kind: "all" }, ctx, { postmortem: false, label: "solved" });
}

/** One poll of the two-phase solved protocol. */
function checkSolved(run: HordeRun, ctx: ExtensionCommandContext): void {
  const state = resolveSolvedState(readSolvedState(run.runDir));
  if (!run.solved && state.proposal) adoptProposal(run, state.proposal);
  const solved = run.solved;
  if (!solved) return;
  if (state.contest) {
    dropContested(run, state.contest);
    return;
  }
  const validator =
    state.confirm && state.confirm.member !== solved.member ? state.confirm.member : undefined;
  // Peer confirmation is evidence even when coverage or acceptance still blocks completion.
  if (validator) run.solvedValidatedBy = validator;
  if (run.stopped) return;
  if (coveragePending(run, validator)) return;
  const collaboration = loadCollaborationReport(run.hordeDir, run.id);
  if (collaboration.issues.length || openMessages(collaboration.state).length) return;
  const othersRunning = run.members.some(
    (member) =>
      (member.status === "running" || member.status === "starting") &&
      member.name !== solved.member,
  );
  if (verificationPending(run, othersRunning)) return;
  const waited = Date.now() - Date.parse(solved.at);
  const timedOut = Number.isFinite(waited) && waited >= SOLVED_CONFIRM_MS;
  if (!validator && othersRunning && !timedOut) return;
  commitSolved(run, ctx, validator);
}

/**
 * Two-phase solved: work continues after the first proposal. The run winds
 * down only after validation and, for broad reviews, current-run coverage.
 */
export function startSolvedWatch(run: HordeRun, ctx: ExtensionCommandContext): void {
  let lastError: string | undefined;
  run.solvedTimer = setInterval(() => {
    // An uncaught throw in a timer exits pi; report it once and retry on the next poll.
    try {
      checkSolved(run, ctx);
      lastError = undefined;
    } catch (error) {
      const message = oneLine(String(error), 200);
      if (message !== lastError) safeNotify(run, `horde: solved check failed, retrying: ${message}`, "error");
      lastError = message;
    }
  }, SOLVED_POLL_MS);
  run.solvedTimer.unref?.();
}
