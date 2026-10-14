import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";
const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  "@earendil-works/pi-coding-agent": PI,
  "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
  "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
  typebox: `${DEPS}/typebox/build/index.mjs`,
} });
const { initHordeDir } = await jiti.import("../src/ledger/files.ts");
const { appendRunHeading } = await jiti.import("../src/ledger/board.ts");
const findings = await jiti.import("../src/ledger/findings.ts");
const { clusterFindings } = await jiti.import("../src/ledger/clusters.ts");
const { collaborationState } = await jiti.import("../src/ledger/collaboration.ts");
const { runCollaborationAction } = await jiti.import("../src/tool/collaboration-actions.ts");
const { freezeAcceptance } = await jiti.import("../src/collaboration-report.ts");
const { runReportMarkdown, summaryMarkdown } = await jiti.import("../src/prompt.ts");
const { newMemberState } = await jiti.import("../src/member.ts");
const { buildDiagnosis } = await jiti.import("../src/run/diagnosis.ts");
fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-review-accounting-"));
const hordeDir = initHordeDir(cwd);
const id = "20260928-183827";
const runDir = path.join(hordeDir, "runs", id);
fs.mkdirSync(runDir, { recursive: true });
await appendRunHeading(hordeDir, id, "review accounting fixture");
const review = (actor, finding, unchecked, verdict = "supports") => runCollaborationAction({ hordeDir, runId: id, actor }, {
  action: "review", target: `F${finding.id}`, revision: findings.findingRevision(finding),
  checked: "controlled local mechanism", unchecked, verdict, support: "tested", evidenceText: "independent fixture result", text: "bounded check",
});
for (let n = 1; n <= 10; n++) {
  const finding = (await findings.addFinding(hordeDir, id, "member-1", `Surface ${n} conclusion at src/component-${n}.ts`, { concern: `surface-${n}`, concernDef: `separate component ${n}`, concernNew: true })).finding;
  await review("member-6", finding, "live reachability remains unchecked");
  if (n < 10) await review("member-3", finding, "other operating systems unchecked");
}
let entries = findings.listFindingsForRun(hordeDir, id);
let state = collaborationState(hordeDir, id);
assert.equal(entries.length, 10);
assert.equal(state.reviews.length, 19);
assert.equal(entries.filter((f) => f.verifiedBy).length, 0);
const members = [1, 3, 6].map((n) => Object.assign(newMemberState(n), { status: "done", endCause: "completed" }));
const input = { id, prompt: "review fixture", count: 6, startedAt: Date.now(), stopped: false, members, verifier: "member-6", outcome: "completed", findings: entries, ideas: [], clusters: clusterFindings(entries), claims: [], facts: [], scopedReviews: state.reviews, reviewMessages: state.messages };
const report = runReportMarkdown(input);
assert.match(report, /independent scoped review coverage: 10 of 10 current findings/);
assert.match(report, /0 full-scope supported; 10 limited\/inconclusive/);
assert.match(report, /scoped reviews: 19 current-revision records/);
assert.match(report, /designated verifier scoped checks: 10 records across 10 current findings/);
assert.doesNotMatch(report, /verified: 0 of 10|check methods:\s*\n|check authors[^\n]*:\s*\n/);
assert.match(report, /review=limited checks=V\d+:tested/);
assert.match(summaryMarkdown(input), /member-6[\s\S]*10 independently reviewed \(scoped\)/);
const diagnosis = buildDiagnosis({ members, resets: [] }, { findings: entries, scopedReviews: state.reviews, reviewMessages: state.messages, distinctFindings: 10, claims: [], released: [], latePosts: [] });
assert.match(diagnosis, /finding reviews with limitations: F1, F2/);
assert.doesNotMatch(diagnosis, /unverified findings|without independent review/);
const acceptance = freezeAcceptance(hordeDir, id);
assert.equal(acceptance.status, "incomplete");
assert.equal(acceptance.issues.filter((s) => s.includes("independently reviewed with limitations")).length, 10);
assert.ok(!acceptance.issues.some((s) => s.includes("no independent")), "partial checking must not be called absent checking");
const snapshot = JSON.parse(fs.readFileSync(path.join(runDir, "ACCEPTANCE.json"), "utf8"));
assert.equal(snapshot.findingReviews.filter((r) => r.status === "limited").length, 10);

// Full scope does not require a legacy label; a later refutation overrides support.
await review("member-6", entries[0], "");
assert.ok(!findings.unverifiedFindings(hordeDir, id).some((f) => f.id === entries[0].id));
assert.ok(!freezeAcceptance(hordeDir, id).issues.some((s) => s.startsWith(`F${entries[0].id}:`)));
await review("member-3", entries[0], "", "refutes");
state = collaborationState(hordeDir, id);
assert.equal(findings.findingReviewState(entries[0], state.reviews, state.messages).status, "disputed");
assert.ok(freezeAcceptance(hordeDir, id).issues.some((s) => s.includes("unresolved challenge or refuting review")));
const revised = { ...entries[1], body: "materially changed claim", verifiedBy: "member-2" };
assert.equal(findings.findingReviewState(revised, state.reviews).status, "unreviewed", "stale reviews cannot fall back to a legacy label");
assert.equal(findings.findingReviewState({ ...entries[1], supersededBy: 99 }, state.reviews).status, "superseded");
const selfReview = { ...state.reviews[0], target: `F${entries[9].id}`, revision: findings.findingRevision(entries[9]), actor: entries[9].author, unchecked: "" };
assert.equal(findings.findingReviewState(entries[9], [selfReview]).status, "unreviewed");
console.log(`PASS: review accounting regression (${cwd})`);
