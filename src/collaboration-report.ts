import * as fs from "node:fs";
import * as path from "node:path";
import { artifactAccepted, artifactLimits, blockingMessages, collaborationState, openMessages, partialArtifactReviews } from "./ledger/collaboration.js";
import type { ArtifactRecord, CollaborationState, PeerMessage } from "./ledger/collaboration.js";
import { readEvents } from "./ledger/events.js";
import { findingReviewState, findingRevision, listFindingsForRun } from "./ledger/findings.js";
import { listIdeas } from "./ledger/ideas.js";
import { writeFileAtomic } from "./ledger/files.js";
import { currentTarget, hashText, targetInfo } from "./tool/collaboration-target.js";

export interface CollaborationReport {
  runId: string;
  sequence: number;
  state: CollaborationState;
  issues: string[];
  /** Limits the accepting reviews disclosed outside each accepted artifact's criteria. */
  limits: string[];
  acceptedArtifacts: string[];
  acceptedDocuments: string[];
  acceptedRunnableArtifacts: string[];
  metrics: Record<string, number>;
}

function dependencyProblem(hordeDir: string, runId: string, state: CollaborationState, dependency: ArtifactRecord["dependencies"][number], ancestors: Set<string>): string | undefined {
  const ctx = { hordeDir, runId, actor: "parent" };
  const { target, revision } = dependency;
  let current: string;
  try {
    const successor = currentTarget(ctx, target);
    if (successor !== target) return `dependency ${target} superseded by ${successor}; republish against ${successor} and request a fresh review`;
    current = targetInfo(ctx, state, target).revision;
  } catch (error) {
    return `dependency ${target} unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (current !== revision) return `dependency ${target} changed`;
  if (blockingMessages(state).some((m) => m.target === target)) return `dependency ${target} disputed`;
  const latest = new Map(state.reviews.filter((r) => r.target === target && r.revision === revision).map((r) => [r.actor, r]));
  if ([...latest.values()].some((r) => r.verdict === "refutes")) return `dependency ${target} refuted`;
  const parent = state.artifacts.find((a) => a.id === target);
  if (parent && artifactProblem(hordeDir, runId, state, parent, ancestors)) return `dependency artifact ${target} is not accepted`;
  return undefined;
}

function artifactProblem(hordeDir: string, runId: string, state: CollaborationState, artifact: ArtifactRecord, visited = new Set<string>()): string | undefined {
  if (visited.has(artifact.id)) return "cyclic artifact dependency";
  const ancestors = new Set([...visited, artifact.id]);
  for (const dependency of artifact.dependencies) {
    const problem = dependencyProblem(hordeDir, runId, state, dependency, ancestors);
    if (problem) return problem;
  }
  try {
    const root = fs.realpathSync(path.join(hordeDir, "runs", runId, "artifacts"));
    const file = fs.realpathSync(path.join(hordeDir, "runs", runId, artifact.path));
    if (!file.startsWith(root + path.sep) || hashText(fs.readFileSync(file)) !== artifact.hash) return "file changed after publication";
  } catch { return "published file unavailable"; }
  // A blocker is named as such: the acceptance text is read by members and the deliverable, and
  // "needs a review" sent them after a review that already existed.
  const blocker = blockingMessages(state).find((m) => m.target === artifact.id);
  if (blocker) return `blocked by ${blocker.id} (${blocker.state} blocking ${blocker.kind} from ${blocker.sender})`;
  if (artifactAccepted(state, artifact)) return undefined;
  // A partial review is coverage debt, not an objection: the acceptance names what it left
  // unchecked so a full review, or one covering that scope, can settle it.
  const partial = partialArtifactReviews(state, artifact).map((r) => `${r.id} (${r.actor}) left unchecked: ${r.unchecked.trim()}`);
  const need = artifact.kind === "document"
    ? "needs a full independent review against document criteria"
    : "needs a full independent tested/reproduced review";
  return partial.length ? `${need}; ${partial.join("; ")}` : need;
}

export function loadCollaborationReport(hordeDir: string, runId: string): CollaborationReport {
  const events = readEvents(hordeDir, runId);
  const state = collaborationState(hordeDir, runId);
  const issues = blockingMessages(state).map((m) => `${m.id} ${m.target}: ${m.state} blocking ${m.kind}`);
  const acceptedArtifacts: string[] = [];
  const limits: string[] = [];
  for (const artifact of state.artifacts) {
    const problem = artifactProblem(hordeDir, runId, state, artifact);
    if (problem) {
      issues.push(`${artifact.id}@${artifact.hash}: ${problem}; exclude from recommended ${artifact.kind === "document" ? "document" : "runnable"} outputs`);
      continue;
    }
    acceptedArtifacts.push(artifact.id);
    limits.push(...artifactLimits(state, artifact).map((limit) => `${artifact.id}@${artifact.hash}: accepted with limits outside its criteria; ${limit}`));
  }
  for (const f of listFindingsForRun(hordeDir, runId)) {
    if (f.supersededBy !== undefined) continue;
    const target = `F${f.id}`;
    const revision = findingRevision(f);
    const reviews = state.reviews.filter((r) => r.target === target && r.revision === revision);
    const latest = new Map(reviews.map((r) => [r.actor, r]));
    if ([...latest.values()].some((r) => r.verdict === "refutes")) issues.push(`${target}: current revision refuted`);
    if (state.evidence.some((e) => e.target === target && e.revision === revision && e.relation === "contradicts") && !reviews.some((r) => r.verdict === "supports" && r.evidence.some((id) => state.evidence.find((e) => e.id === id)?.relation === "contradicts"))) issues.push(`${target}: contradicting evidence needs explicit adjudication`);
  }
  const messages = state.messages;
  const delays = messages.flatMap((m) => Object.values(m.deliveries).slice(0, 1).map((time) => Date.parse(time) - Date.parse(m.createdAt)));
  const acceptedDocuments = state.artifacts.filter((a) => a.kind === "document" && acceptedArtifacts.includes(a.id)).map((a) => a.id);
  const acceptedRunnableArtifacts = acceptedArtifacts.filter((id) => !acceptedDocuments.includes(id));
  return { runId, sequence: state.seq, state, issues, limits, acceptedArtifacts, acceptedDocuments, acceptedRunnableArtifacts, metrics: {
    events: events.length, rejected: events.filter((e) => e.outcome === "rejected").length,
    unresolved: openMessages(state).length, blocking: blockingMessages(state).length,
    resolvedChallenges: messages.filter((m) => m.kind === "challenge" && m.state === "resolved").length,
    deferredChallenges: messages.filter((m) => m.kind === "challenge" && m.state === "deferred").length,
    openChallenges: messages.filter((m) => m.kind === "challenge" && m.state !== "resolved" && m.state !== "deferred").length,
    meanDeliveryMs: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : 0,
    acceptedArtifacts: acceptedArtifacts.length,
    acceptedDocuments: acceptedDocuments.length, acceptedRunnableArtifacts: acceptedRunnableArtifacts.length,
  } };
}

function withEvidence(text: string, evidence: string[] | undefined): string {
  return evidence?.length ? `${text} (evidence ${evidence.join(", ")})` : text;
}

/** The response and the resolution are different actors' decisions; each shows with its own evidence. */
function messageMarkdown(m: PeerMessage): string {
  const lines = [
    `- ${m.id} ${m.sender} -> ${m.to} ${m.target}@${m.revision} [${m.state}] ${m.kind}${m.blocking ? " BLOCKING" : ""}`,
    `  ${m.text}`,
    `  Response: ${m.response ? withEvidence(m.response, m.responseEvidence) : "pending"}`,
  ];
  if (m.resolution !== undefined) lines.push(`  ${m.state === "deferred" ? "Deferred" : "Resolution"}: ${withEvidence(m.resolution, m.resolutionEvidence)}`);
  lines.push(`  Evidence: ${m.evidence.join(", ") || "none"}; created ${m.createdAt}; updated ${m.updatedAt}`);
  return lines.join("\n");
}

function collaborationMarkdown(report: CollaborationReport): string {
  const { state } = report;
  return [
    `# Collaboration ${report.runId}`, `\nEvent high-water mark: ${report.sequence}. Delivery records context insertion, not comprehension.`,
    "\n## Acceptance issues", ...(report.issues.length ? report.issues.map((i) => `- ${i}`) : ["- No protocol-level issues recorded; task acceptance still requires coverage and review."]),
    "\n## Accepted with limits", ...(report.limits.length ? report.limits.map((l) => `- ${l}`) : ["- none disclosed"]),
    "\n## Questions, challenges and handoffs", ...state.messages.map(messageMarkdown),
    "\n## Artifact revisions", ...state.artifacts.map((a) => `- ${a.id} ${a.path}@${a.hash} owner=${a.owner} kind=${a.kind ?? "runnable"} snapshot=${a.snapshot} accepted=${report.acceptedArtifacts.includes(a.id)}\n  Criteria: ${a.criteria}\n  Dependencies: ${JSON.stringify(a.dependencies)}${a.changeNote ? `\n  Change: ${a.changeNote}` : ""}`),
    "\n## Reviews", ...state.reviews.map((r) => `- ${r.id} ${r.target}@${r.revision} @${r.actor} ${r.verdict} [${r.support}] evidence=${r.evidence.join(",")}${r.reattests ? ` reattests=${r.reattests}` : ""}\n  Checked: ${r.checked}\n  Unchecked: ${r.unchecked || "none declared"}\n  Limits: ${r.limits || "none disclosed"}\n  ${r.text}`),
    "\n## Evidence", ...state.evidence.map((e) => `- ${e.id} ${e.target}@${e.revision} @${e.actor} ${e.relation}${e.path ? ` ${e.path}@${e.hash}` : ""}\n  ${e.text}`),
    "\n## Resources", ...state.resources.map((r) => `- ${r.target} ${r.state} generation=${r.generation} @${r.owner}/${r.attempt} ports=${r.ports.join(",")} lease=${new Date(r.leaseUntil).toISOString()}\n  Health: ${r.health}`),
    "\n## Metrics", ...Object.entries(report.metrics).map(([key, value]) => `- ${key}: ${value}`), "",
  ].join("\n");
}

/** Freeze all synthesis inputs together after workers/repair sessions have exited. */
export function freezeAcceptance(hordeDir: string, runId: string, startIdeaId = 0): { status: string; hash: string; issues: string[] } {
  const report = loadCollaborationReport(hordeDir, runId);
  const findings = listFindingsForRun(hordeDir, runId);
  const ideas = listIdeas(hordeDir);
  const issues = [...report.issues];
  for (const idea of ideas.filter((i) => i.id > startIdeaId && [" ", "~"].includes(i.mark))) issues.push(`I${idea.id}: coverage incomplete`);
  const findingReviews = findings.map((f) => ({ target: `F${f.id}`, ...findingReviewState(f, report.state.reviews, report.state.messages) }));
  for (const check of findingReviews) {
    if (check.status === "unreviewed") issues.push(`${check.target}: no independent review of the current revision`);
    if (check.status === "limited") issues.push(`${check.target}: independently reviewed with limitations; full claim coverage is not established (see ${check.reviews.map((r) => r.id).join(", ")})`);
    if (check.status === "disputed") issues.push(`${check.target}: unresolved challenge or refuting review`);
  }
  const runDir = path.join(hordeDir, "runs", runId);
  const snapshot = { report, findings, findingReviews, ideas, issues, limits: report.limits };
  const hash = hashText(JSON.stringify(snapshot));
  const status = issues.length ? "incomplete" : "reviewed";
  writeFileAtomic(path.join(runDir, "COLLABORATION.md"), collaborationMarkdown(report));
  writeFileAtomic(path.join(runDir, "ACCEPTANCE.json"), JSON.stringify({ ...snapshot, hash, status }, null, 2));
  const limitsSection = report.limits.length ? `\n\n## Accepted with limits\n\n${report.limits.map((l) => `- ${l}`).join("\n")}` : "";
  writeFileAtomic(path.join(runDir, "ACCEPTANCE.md"), `# Acceptance ${runId}\n\nStatus: ${status}\nSnapshot: ${hash}\nEvent sequence: ${report.sequence}\n\n${issues.map((i) => `- ${i}`).join("\n")}${limitsSection}\n`);
  const dir = path.join(runDir, "snapshot");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["BOARD", "FINDINGS", "IDEAS", "FACTS", "CLAIMS", "RESOURCES", "CONCERNS"]) {
    const file = path.join(hordeDir, `${name}.md`);
    if (fs.existsSync(file)) writeFileAtomic(path.join(dir, `${name}.md`), fs.readFileSync(file, "utf8"));
  }
  return { status, hash, issues };
}
