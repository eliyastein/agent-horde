import type { BoardEntry } from "../ledger/board.js";
import type { ClaimEntry } from "../ledger/claims.js";
import { findingReviewState } from "../ledger/findings.js";
import type { FindingEntry } from "../ledger/findings.js";
import type { ReviewRecord, PeerMessage } from "../ledger/collaboration.js";
import type { MemberState } from "../member.js";
import type { HordeRun } from "./types.js";

interface DiagnosisInput {
  findings: FindingEntry[];
  scopedReviews?: ReviewRecord[];
  reviewMessages?: PeerMessage[];
  /** Number of clusters the findings fold into. */
  distinctFindings: number;
  claims: ClaimEntry[];
  /** Ideas returned to the open pool at finalize. */
  released: number[];
  /** Board posts that landed after the last finding. */
  latePosts: BoardEntry[];
}

/** One-line run diagnosis for the report message: outcome, debt, and anomalies. */
export function buildDiagnosis(run: HordeRun, input: DiagnosisInput): string {
  const { findings, distinctFindings, claims, released, latePosts } = input;
  const parts: string[] = [];
  if (run.solved) {
    parts.push(
      `${run.acceptance === "incomplete" ? "answer proposed" : "goal solved"} by ${run.solved.member}` +
        (run.solvedValidatedBy ? `, peer-confirmed by ${run.solvedValidatedBy}` : " (unvalidated)") +
        (run.acceptance === "incomplete" ? ", acceptance incomplete" : ""),
    );
  } else if (run.solvedContested) {
    parts.push("solved proposal contested; no validated answer");
  }
  const reviews = findings.map((finding) => ({ id: finding.id, status: findingReviewState(finding, input.scopedReviews, input.reviewMessages).status }));
  for (const [status, label] of [["unreviewed", "findings without independent review"], ["limited", "finding reviews with limitations"], ["disputed", "disputed findings"]]) {
    const entries = reviews.filter((r) => r.status === status);
    if (entries.length) parts.push(`${label}: ${entries.map((r) => `F${r.id}`).join(", ")}`);
  }
  if (run.canary === "failed") parts.push(`canary failed (${run.canaryError ?? "no output"})`);
  parts.push(`${findings.length} raw findings in ${distinctFindings} distinct clusters`);
  const isDeliberateStop = (m: MemberState): boolean =>
    m.endCause === "killed" && !m.repairStopReason && run.stopLabel !== undefined;
  const stoppedMembers = run.members.filter(isDeliberateStop);
  if (stoppedMembers.length > 0) {
    parts.push(`${run.stopLabel}: ${stoppedMembers.map((m) => m.name).join(", ")}`);
  }
  const abnormal = run.members.filter(
    (m) => m.endCause && m.endCause !== "completed" && !isDeliberateStop(m),
  );
  if (abnormal.length > 0) {
    parts.push(`abnormal ends: ${abnormal.map((m) => `${m.name} ${m.endCause}${m.repairStopReason ? ` (repair ${m.repairStopReason})` : ""}`).join(", ")}`);
  }
  const partials = run.members.filter((m) => m.partial);
  if (partials.length > 0) {
    parts.push(`partial work kept from ${partials.map((m) => m.name).join(", ")}`);
  }
  if (run.resets.length > 0) {
    parts.push(`resets: ${run.resets.map((r) => `${r.member} (${r.reason})`).join(", ")}`);
  }
  const flagged = claims.filter(
    (c) => c.state === "contested" || c.state === "retracted" || c.state === "unverified",
  );
  if (flagged.length > 0) {
    parts.push(`flagged claims: ${flagged.map((c) => `C${c.id} ${c.state}`).join(", ")}`);
  }
  const supersededMap = new Map<number, number>();
  for (const finding of findings) {
    if (finding.supersedes !== undefined) supersededMap.set(finding.supersedes, finding.id);
    if (finding.supersededBy !== undefined) supersededMap.set(finding.id, finding.supersededBy);
  }
  if (supersededMap.size > 0) {
    parts.push(
      `superseded: ${[...supersededMap].map(([oldId, byId]) => `F${oldId} by F${byId}`).join(", ")}`,
    );
  }
  if (released.length > 0) {
    parts.push(`released unworked: ${released.map((id) => `#${id}`).join(", ")}`);
  }
  if (latePosts.length > 0) {
    const authors = [...new Set(latePosts.map((post) => post.author))];
    parts.push(
      `${latePosts.length} board post(s) after the last finding by ${authors.join(", ")} ` +
        "(check BOARD.md for results that were never filed)",
    );
  }
  return parts.join("; ");
}
