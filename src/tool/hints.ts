import * as path from "node:path";
import { pendingReviewsForMember } from "../ledger/findings.js";
import { listIdeas } from "../ledger/ideas.js";
import { readSolvedState } from "../ledger/run-signals.js";
import { oneLine } from "../format.js";

/** Nudge a member about a pending SOLVED proposal that needs a second validator. */
export function solvedHint(
  hordeDir: string,
  runId: string | undefined,
  member: string,
  action: string,
): string {
  if (!runId || action === "solved" || action === "confirm-solved" || action === "contest-solved") {
    return "";
  }
  try {
    const state = readSolvedState(path.join(hordeDir, "runs", runId));
    if (!state.proposal || state.confirm || state.contest) return "";
    if (state.proposal.member === member) {
      return `\nYour SOLVED proposal is pending validation by another member.`;
    }
    return (
      `\nA SOLVED proposal from ${state.proposal.member} is pending: "${oneLine(state.proposal.text, 200)}". ` +
      `If you can independently verify it, call 'horde confirm-solved' with your evidence; ` +
      `if it is premature, call 'horde contest-solved' with what is still missing.`
    );
  } catch {
    return "";
  }
}

/** List the findings a verifier can still reproduce, so a snapshot cannot read as final. */
export function pendingVerificationHint(hordeDir: string, runId: string, member: string): string {
  try {
    const pending = pendingReviewsForMember(hordeDir, runId, member);
    if (pending.length === 0) return "";
    return (
      `\nPending verification (${pending.length}): ` +
      pending.map((finding) => `F${finding.id} ${oneLine(finding.title, 80)}`).join("; ") +
      ". Check a specific uncovered assertion; avoid repeating existing reviews. Disclose remaining gaps."
    );
  } catch {
    return "";
  }
}

/** Nudge a member that has no claimed work while open ideas remain. */
export function idleHint(hordeDir: string, member: string): string {
  try {
    const ideas = listIdeas(hordeDir);
    if (ideas.some((idea) => idea.mark === "~" && idea.owner === member)) return "";
    const open = ideas.filter((idea) => idea.mark === " ");
    if (open.length === 0) return "";
    return (
      `\nYou have no claimed work. Open ideas: ` +
      `${open.map((idea) => `#${idea.id} ${idea.text}`).join("; ")}. Claim one before stopping.`
    );
  } catch {
    return "";
  }
}
