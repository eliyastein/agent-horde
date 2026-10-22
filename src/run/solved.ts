import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { oneLine } from "../format.js";
import { loadCollaborationReport } from "../collaboration-report.js";
import { openMessages } from "../ledger/collaboration.js";
import { postBoard } from "../ledger/board.js";
import { unsettledFactCitations } from "../ledger/facts.js";
import { listFindingsForRun, staleAnswerCitations, unverifiedFindings } from "../ledger/findings.js";
import { listIdeas } from "../ledger/ideas.js";
import { archiveSolved, clearCleanStop, clearSolved, readSolvedState, reopenSolved, resolveSolvedState, writeAnswer } from "../ledger/run-signals.js";
import type { SolvedSignal } from "../ledger/run-signals.js";
import { hardStopMembers, requestCleanStop } from "./controls.js";
import { recordLifecycle, UNTIL_STOP_REASON } from "./lifecycle.js";
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

/** Idea ids a contest names as what is still missing; the proposal reopens once they close. */
export function contestBlockers(text: string): number[] {
  return [...new Set([...text.matchAll(/(?:^|[\s(,;])#(\d{1,6})\b/g)].map((m) => Number(m[1])))];
}

function clearProposal(run: HordeRun): void {
  archiveSolved(run.runDir);
  clearSolved(run.runDir);
  if (!run.stopped) clearCleanStop(run.runDir);
  run.solved = undefined;
  run.solvedValidatedBy = undefined;
  run.solvedCommitted = false;
  run.solvedCoverageNotice = undefined;
  run.solvedVerificationNotice = undefined;
}

function dropContested(run: HordeRun, proposal: SolvedSignal, contest: SolvedSignal): void {
  const blockers = contestBlockers(contest.text);
  safeNotify(run, `horde ${run.id}: solved proposal contested by ${contest.member}`, "warning");
  void recordLifecycle(run, "solved-contested", { member: contest.member, text: oneLine(contest.text, 200), blockers });
  const reopens = blockers.length ? ` It reopens for validation once ${blockers.map((id) => `#${id}`).join(", ")} are done or ruled out.` : "";
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED proposal contested by ${contest.member}: ${contest.text}. Work continues.${reopens}`,
  );
  clearProposal(run);
  run.solvedContested = true;
  run.solvedContest = blockers.length ? { proposal, blockers } : undefined;
  refreshRun(run);
}

/**
 * A proposal that cites a finding superseded or amended after it was made would ship the stale
 * reading as the answer. It is withdrawn for re-proposal rather than validated; the board names
 * the successor or the amendment.
 */
function withdrawStale(run: HordeRun, proposal: SolvedSignal, stale: string[]): void {
  const reason = `cites ${stale.join(", ")}`;
  safeNotify(run, `horde ${run.id}: solved proposal withdrawn; it ${reason}`, "warning");
  void recordLifecycle(run, "solved-withdrawn", { member: proposal.member, reason });
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED proposal by ${proposal.member} withdrawn: it ${reason}. ${proposal.member}: propose again citing the current findings.`,
  );
  clearProposal(run);
  refreshRun(run);
}

/**
 * A contest that named open ideas as what was missing is answered by their closing: nothing else
 * reopens the vote, so the run ended `solved-contested` with the closed negatives unapplied.
 */
function reopenContested(run: HordeRun): void {
  const contest = run.solvedContest;
  if (!contest || run.stopped) return;
  const closed = new Map(listIdeas(run.hordeDir).map((idea) => [idea.id, idea.mark === "x" || idea.mark === "!"]));
  if (!contest.blockers.every((id) => closed.get(id))) return;
  const named = contest.blockers.map((id) => `#${id}`).join(", ");
  const reason = `contest blockers ${named} closed`;
  // The proposal returns with the citations it pinned when it was made; what went stale or
  // unsettled meanwhile makes it a re-proposal for its author, not a reopening.
  const stale = [
    ...staleAnswerCitations(listFindingsForRun(run.hordeDir, run.id), contest.proposal.text, contest.proposal.cites),
    ...unsettledFactCitations(run.hordeDir, contest.proposal.text).map((citation) => `provisional ${citation}`),
  ];
  run.solvedContest = undefined;
  if (stale.length) {
    const why = `cites ${stale.join(", ")}`;
    void recordLifecycle(run, "solved-withdrawn", { member: contest.proposal.member, reason: why });
    void postBoard(run.hordeDir, "parent", `SOLVED proposal by ${contest.proposal.member} is not re-opened after ${reason}: it ${why}. ${contest.proposal.member}: propose again citing the current findings.`);
    return;
  }
  const signal = reopenSolved(run.runDir, run.id, contest.proposal, `re-opened: ${reason}; awaiting validation`, contest.proposal.cites);
  run.solvedContested = false;
  void recordLifecycle(run, "solved-reopened", { member: signal.member, reason, revision: signal.revision });
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED proposal by ${signal.member} re-opened: ${reason}. Another member must validate it against the closed ideas with 'horde confirm-solved' or contest it again.`,
  );
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

/**
 * `--until-stop`: bank the validated answer and put one member back on ideation instead of
 * winding down. The proposer is preferred; the verifier keeps its role unless it is all that is left.
 */
function continueAfterSolve(run: HordeRun, proposal: SolvedSignal, validator: string | undefined): void {
  run.solveRounds = (run.solveRounds ?? 0) + 1;
  run.lastRound = { proposal, validator };
  const status = validator ? `validated by ${validator}` : "committed without a separate validator";
  try {
    writeAnswer(run.runDir, run.id, proposal, `${status} (round ${run.solveRounds}; run continues until stopped)`);
  } catch (error) {
    safeNotify(run, `horde ${run.id}: could not write ANSWER.md (${oneLine(String(error), 200)})`, "error");
  }
  clearProposal(run);
  run.solvedContest = undefined;
  const live = run.members.filter((m) => (m.status === "running" || m.status === "starting") && !m.paused);
  const member = live.find((m) => m.name === proposal.member) ?? live.find((m) => m.name !== run.verifier) ?? live[0];
  void recordLifecycle(run, "solved-round", { round: run.solveRounds, member: proposal.member, validator, reactivated: member?.name });
  safeNotify(run, `horde ${run.id}: solve #${run.solveRounds} banked; continuing until stopped`, "info");
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED ${status} (round ${run.solveRounds}); this run continues until the user stops it. ` +
      `${member ? `${member.name} is reactivated to generate new ideas: ` : ""}extend, stress-test, or deepen the work and propose SOLVED again when a materially better answer exists.`,
  );
  if (member) {
    member.resetPending = `${UNTIL_STOP_REASON}: solve round ${run.solveRounds} banked`;
    hardStopMembers(run, [member.name]);
  }
  refreshRun(run);
}

function commitSolved(
  run: HordeRun,
  ctx: ExtensionCommandContext,
  validator: string | undefined,
): void {
  if (run.untilStop && run.solved && !run.stopped) {
    continueAfterSolve(run, run.solved, validator);
    return;
  }
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
export function checkSolved(run: HordeRun, ctx: ExtensionCommandContext): void {
  const state = resolveSolvedState(readSolvedState(run.runDir));
  if (!run.solved && state.proposal) {
    run.solvedContest = undefined;
    adoptProposal(run, state.proposal);
  }
  const solved = run.solved;
  if (!solved) {
    reopenContested(run);
    return;
  }
  if (state.contest) {
    dropContested(run, solved, state.contest);
    return;
  }
  const stale = staleAnswerCitations(listFindingsForRun(run.hordeDir, run.id), solved.text, solved.cites);
  if (stale.length && !run.solvedCommitted) {
    withdrawStale(run, solved, stale);
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
