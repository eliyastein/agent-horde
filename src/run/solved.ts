import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { oneLine } from "../format.js";
import { loadCollaborationReport } from "../collaboration-report.js";
import { openMessages } from "../ledger/collaboration.js";
import { postBoard } from "../ledger/board.js";
import { unsettledFactCitations } from "../ledger/facts.js";
import { answerOmittedFor, answerStaleFor, unverifiedFindings } from "../ledger/findings.js";
import { listIdeas } from "../ledger/ideas.js";
import {
  archiveSolved, carryConfirmation, clearCleanStop, clearSolved, contestBlockers, readSolvedState, reopenSolved,
  REPEAT_CONTEST_LIMIT, resolveSolvedState, unansweredContests, writeAnswer,
} from "../ledger/run-signals.js";
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

function sameAnswer(a: SolvedSignal, b: SolvedSignal): boolean {
  const pins = (signal: SolvedSignal): string => JSON.stringify(Object.entries(signal.cites ?? {}).sort());
  return a.text.trim() === b.text.trim() && pins(a) === pins(b);
}

/**
 * A proposal whose text and pinned citations are those another member already confirmed keeps
 * that confirmation: a new revision id for the same content gives a validator nothing new to
 * check. Only a contest answered by its named ideas closing leaves a confirmation to carry; a
 * contest with no open idea to wait on, or a withdrawal, discards it, so the same text proposed
 * again is validated afresh. A contest of the new revision still overrides a carried one.
 */
function carriedConfirmation(run: HordeRun, proposal: SolvedSignal): string | undefined {
  const earlier = run.solvedConfirmation;
  if (!earlier || earlier.validator === proposal.member || !sameAnswer(earlier.proposal, proposal)) return undefined;
  carryConfirmation(run.runDir, run.id, proposal, { validator: earlier.validator, revision: earlier.proposal.revision });
  void recordLifecycle(run, "solved-validation-carried", {
    member: proposal.member, validator: earlier.validator, from: earlier.proposal.revision, revision: proposal.revision,
  });
  return earlier.validator;
}

function adoptProposal(run: HordeRun, proposal: SolvedSignal): void {
  run.solved = proposal;
  run.solvedValidatedBy = undefined;
  run.solvedCommitted = false;
  run.solvedContested = false;
  run.solvedVerificationNotice = undefined;
  run.solvedOmittedNoted = undefined;
  void recordLifecycle(run, "solved-proposed", { member: proposal.member, text: oneLine(proposal.text, 200) });
  safeNotify(run, `horde ${run.id}: ${proposal.member} proposed the goal solved`, "info");
  const carried = carriedConfirmation(run, proposal);
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED proposed by ${proposal.member}: ${oneLine(proposal.text, 200)}. ` +
      (carried
        ? `Its text and citations are the ones ${carried} already confirmed, so that confirmation carries over; refute it with 'horde contest-solved' if it no longer holds.`
        : "Another member must validate with 'horde confirm-solved' or refute it with 'horde contest-solved'."),
  );
  refreshRun(run);
}

/** The ideas still open or in progress; an unreadable ledger names none. */
function openIdeaIds(run: HordeRun): Set<number> {
  try {
    return new Set(listIdeas(run.hordeDir).filter((idea) => idea.mark === " " || idea.mark === "~").map((idea) => idea.id));
  } catch {
    // A missing ideas ledger is reported at finalize; a contest then waits on nothing.
    return new Set();
  }
}

function clearProposal(run: HordeRun, blockers: number[] = []): void {
  archiveSolved(run.runDir, undefined, blockers);
  clearSolved(run.runDir);
  if (!run.stopped) clearCleanStop(run.runDir);
  run.solved = undefined;
  run.solvedValidatedBy = undefined;
  run.solvedCommitted = false;
  run.solvedCoverageNotice = undefined;
  run.solvedVerificationNotice = undefined;
  run.solvedOmittedNoted = undefined;
}

/**
 * Only ideas open at the contest can reopen the proposal by closing: a contest naming closed
 * ideas, or a document to republish, reopened the unchanged text at once, three times in one run.
 * A contest that names no open idea is answered by a changed answer, and the same text collecting
 * `REPEAT_CONTEST_LIMIT` of them is refused when proposed again.
 */
function dropContested(run: HordeRun, proposal: SolvedSignal, contest: SolvedSignal): void {
  safeNotify(run, `horde ${run.id}: solved proposal contested by ${contest.member}`, "warning");
  const open = openIdeaIds(run);
  const blockers = contestBlockers(contest.text).filter((id) => open.has(id));
  // Archived first, so the count of unanswered contests against this text includes this one.
  clearProposal(run, blockers);
  const repeats = unansweredContests(run.runDir, proposal.text).length;
  const changed = `${proposal.member} or any other member proposes a changed answer that addresses it.`;
  const next = blockers.length
    ? ` It reopens for validation once ${blockers.map((id) => `#${id}`).join(", ")} are done or ruled out.`
    : repeats >= REPEAT_CONTEST_LIMIT
      ? ` This exact answer has now been contested ${repeats} times without an open idea to wait on; it is refused if proposed again unchanged. ${changed}`
      : ` The contest names no open idea, so nothing reopens this proposal: ${changed}`;
  // Closing ideas cannot answer this contest, so the confirmation it overrode does not come back.
  if (!blockers.length) run.solvedConfirmation = undefined;
  void recordLifecycle(run, "solved-contested", { member: contest.member, text: oneLine(contest.text, 200), blockers, repeats });
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED proposal contested by ${contest.member}: ${contest.text}. Work continues.${next}`,
  );
  run.solvedContested = true;
  run.solvedContest = blockers.length ? { proposal, blockers } : undefined;
  refreshRun(run);
}

/**
 * ANSWER.md keeps the withdrawn text for the record, but its status must stop naming the
 * validation it held, or the run reads as validated after the proposal is gone.
 */
function recordWithdrawn(run: HordeRun, proposal: SolvedSignal, reason: string): void {
  run.solvedConfirmation = undefined;
  void recordLifecycle(run, "solved-withdrawn", { member: proposal.member, reason });
  try {
    writeAnswer(run.runDir, run.id, proposal, `withdrawn: it ${reason}; no validation carries over and no proposal is pending`);
  } catch (error) {
    safeNotify(run, `horde ${run.id}: could not write ANSWER.md (${oneLine(String(error), 200)})`, "error");
  }
}

/**
 * A proposal that cites a finding superseded or amended, or an artifact republished, after it was
 * made would ship the stale reading as the answer, and one that never names a finding filed since
 * would ship without it. It is withdrawn for re-proposal rather than validated; the board names
 * the successor, the amendment, the republish, or the omitted finding.
 */
function withdrawStale(run: HordeRun, proposal: SolvedSignal, reason: string): void {
  safeNotify(run, `horde ${run.id}: solved proposal withdrawn; it ${reason}`, "warning");
  recordWithdrawn(run, proposal, reason);
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED proposal by ${proposal.member} withdrawn: it ${reason}. ${proposal.member}, or any other member: propose again citing the current findings.`,
  );
  clearProposal(run);
  refreshRun(run);
}

/**
 * A finding filed after the answer was first proposed does not withdraw it; the proposer could not
 * have named it and a confirmation stands. The members are told once per change so the proposer can
 * fold it into the answer or exclude it; until then the finalize caveat still names it.
 */
function noteOmittedFindings(run: HordeRun, proposal: SolvedSignal): void {
  const omitted = answerOmittedFor(run.hordeDir, run.id, proposal);
  const key = omitted.join(",");
  if (key === (run.solvedOmittedNoted ?? "")) return;
  run.solvedOmittedNoted = key;
  if (!omitted.length) return;
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED proposal by ${proposal.member} stands; ${omitted.join(", ")} ${omitted.length === 1 ? "was" : "were"} filed after it. ` +
      `${proposal.member}: fold ${omitted.length === 1 ? "it" : "them"} into the answer or state why excluded. The answer is not withdrawn for this.`,
  );
}

/**
 * A contest that named open ideas as what was missing is answered by their closing: nothing else
 * reopens the vote, so the run ended `solved-contested` with the closed negatives unapplied. The
 * reopened proposal has the same text and citations, so a confirmation it held carries over.
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
  const provisional = unsettledFactCitations(run.hordeDir, contest.proposal.text).map((citation) => `provisional ${citation}`);
  const why = answerStaleFor(run.hordeDir, run.id, contest.proposal, provisional);
  run.solvedContest = undefined;
  if (why) {
    recordWithdrawn(run, contest.proposal, why);
    void postBoard(run.hordeDir, "parent", `SOLVED proposal by ${contest.proposal.member} is not re-opened after ${reason}: it ${why}. ${contest.proposal.member}, or any other member: propose again citing the current findings.`);
    return;
  }
  const signal = reopenSolved(run.runDir, run.id, contest.proposal, `re-opened: ${reason}; awaiting validation`);
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
 * `--until-stop`: bank the answer as the run's current one and reopen the proposal slot, so a
 * materially better answer can be proposed later. Nobody is stopped; the supervisor gives every
 * member that finishes a fresh session.
 */
function bankSolved(run: HordeRun, proposal: SolvedSignal, validator: string | undefined): void {
  run.solveRounds = (run.solveRounds ?? 0) + 1;
  run.lastRound = { proposal, validator };
  const status = validator ? `validated by ${validator}` : "committed without a separate validator";
  try {
    writeAnswer(run.runDir, run.id, proposal, `${status} (banked as round ${run.solveRounds}; the run continues until stopped)`);
  } catch (error) {
    safeNotify(run, `horde ${run.id}: could not write ANSWER.md (${oneLine(String(error), 200)})`, "error");
  }
  clearProposal(run);
  run.solvedContest = undefined;
  void recordLifecycle(run, "solved-banked", { round: run.solveRounds, member: proposal.member, validator });
  safeNotify(run, `horde ${run.id}: solve banked as round ${run.solveRounds}; the run continues until stopped`, "info");
  void postBoard(
    run.hordeDir,
    "parent",
    `SOLVED ${status}, banked as round ${run.solveRounds}: ${oneLine(proposal.text, 200)}. ` +
      "This run continues until the user stops it. Keep working: extend, stress-test, or deepen the work, " +
      "add ideas for what is still unexplored, and propose SOLVED again only when a materially better answer exists.",
  );
  refreshRun(run);
}

function commitSolved(
  run: HordeRun,
  ctx: ExtensionCommandContext,
  validator: string | undefined,
): void {
  if (run.untilStop && run.solved && !run.stopped) {
    bankSolved(run, run.solved, validator);
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
  const raw = readSolvedState(run.runDir);
  const state = resolveSolvedState(raw);
  if (!run.solved && state.proposal) {
    run.solvedContest = undefined;
    adoptProposal(run, state.proposal);
  }
  const solved = run.solved;
  if (!solved) {
    reopenContested(run);
    return;
  }
  // Read before the contest check: a contest in the same poll hides the confirmation it follows.
  if (raw.confirm && raw.confirm.revision === solved.revision && raw.confirm.member !== solved.member) {
    run.solvedConfirmation = { proposal: solved, validator: raw.confirm.member };
  }
  if (state.contest) {
    dropContested(run, solved, state.contest);
    return;
  }
  const stale = answerStaleFor(run.hordeDir, run.id, solved);
  if (stale && !run.solvedCommitted) {
    withdrawStale(run, solved, stale);
    return;
  }
  noteOmittedFindings(run, solved);
  const validator =
    state.confirm && state.confirm.member !== solved.member ? state.confirm.member : undefined;
  // Peer confirmation is evidence even when coverage or acceptance still blocks completion.
  if (validator) run.solvedValidatedBy = validator;
  if (run.stopped) return;
  if (coveragePending(run, validator)) return;
  const collaboration = loadCollaborationReport(run.hordeDir, run.id);
  if (collaboration.issues.length || openMessages(collaboration.state).length) return;
  // Members of an `--until-stop` run are always coming back, so a lull between sessions is not
  // the absence of a validator; the proposal waits for one or for the timeout.
  const othersRunning = run.untilStop === true || run.members.some(
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
