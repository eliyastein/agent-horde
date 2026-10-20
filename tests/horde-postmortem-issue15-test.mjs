// Regressions for issue #15 (post-mortem follow-ups):
// - acceptance names the blocking message instead of asking for a review that exists
// - a coverage-only partial review's challenge is cleared by another member's full-scope support
// - review citations are judged per sentence, so a document review in the next sentence is not flagged
// (the repair re-ordering case is in horde-repair-test.mjs)
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
const files = await jiti.import("../src/ledger/files.ts");
const board = await jiti.import("../src/ledger/board.ts");
const findings = await jiti.import("../src/ledger/findings.ts");
const collab = await jiti.import("../src/ledger/collaboration.ts");
const protocol = await jiti.import("../src/tool/collaboration-actions.ts");
const report = await jiti.import("../src/collaboration-report.ts");
const citations = await jiti.import("../src/citations.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue15-"));
const hordeDir = files.initHordeDir(cwd);
let call = 0;
const command = async (runId, actor, params) =>
  JSON.parse((await protocol.runCollaborationAction({ hordeDir, runId, actor, attempt: "a1", requestId: `call-${++call}` }, params)).text);
const makeRun = async (runId, members = 4) => {
  const runDir = path.join(hordeDir, "runs", runId);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), `Members: ${members}\n`);
  await board.appendRunHeading(hordeDir, runId, `issue 15 fixture ${runId}`);
  return runDir;
};
const publish = async (runId, runDir, name) => {
  fs.writeFileSync(path.join(runDir, `artifacts/${name}.md`), `# ${name}\n\nfindings and method\n`);
  return (await command(runId, "member-1", { action: "artifact", artifactPath: `artifacts/${name}.md`, artifactKind: "document", criteria: "accurate and sourced" })).artifact;
};
const review = (runId, actor, target, revision, extra) =>
  command(runId, actor, { action: "review", target, revision, support: "sourced", checked: "the stated scope", text: "review", ...extra });
const fileFinding = async (runId, author, text, n) =>
  (await findings.addFinding(hordeDir, runId, author, text, { concern: `concern-${n}`, concernDef: `component ${n}`, concernNew: true })).finding;
const state = (runId) => collab.collaborationState(hordeDir, runId);
const issuesFor = (runId, id) => report.loadCollaborationReport(hordeDir, runId).issues.filter((issue) => issue.startsWith(`${id}@`));

// ---- A. acceptance names the blocker --------------------------------------------------------------
{
  const runId = "20261019-500001";
  const runDir = await makeRun(runId);
  const doc = await publish(runId, runDir, "integrated");
  assert.deepEqual(issuesFor(runId, doc.id), [`${doc.id}@${doc.hash}: needs a full independent review against document criteria; exclude from recommended document outputs`]);
  await review(runId, "member-2", doc.id, doc.hash, { verdict: "supports", unchecked: "", evidenceText: "every citation resolves" });
  assert.deepEqual(issuesFor(runId, doc.id), [], "a full-scope non-owner review accepts the document");
  const objection = (await command(runId, "member-3", { action: "message", target: doc.id, kind: "challenge", text: "section 4 misreads the RDAP record" })).message;
  assert.deepEqual(issuesFor(runId, doc.id), [`${doc.id}@${doc.hash}: blocked by ${objection.id} (pending blocking challenge from member-3); exclude from recommended document outputs`]);
  assert.ok(!report.loadCollaborationReport(hordeDir, runId).issues.some((issue) => issue.includes("needs a full independent review")), "the review that exists is not asked for again");
}

// ---- B. a coverage-only partial review's challenge is cleared by another member's full review ------
{
  const runId = "20261019-500002";
  const runDir = await makeRun(runId);
  const doc = await publish(runId, runDir, "report");
  const partial = await review(runId, "member-2", doc.id, doc.hash, { verdict: "partially-supports", unchecked: "operator and infrastructure sections are outside this slice", evidenceText: "detection sections hold" });
  assert.ok(partial.message?.blocking, "a partial review raises a blocking challenge");
  assert.match(issuesFor(runId, doc.id)[0], new RegExp(`blocked by ${partial.message.id}`));
  await command(runId, "member-2", { action: "defer", target: partial.message.id, text: "scope debt, not a defect" });
  const full = await review(runId, "member-3", doc.id, doc.hash, { verdict: "supports", unchecked: "", evidenceText: "chronology, RDAP and academic counts verified" });
  assert.deepEqual(full.clearances?.map((c) => c.id), [partial.message.id], "the full review records the clearance");
  const cleared = state(runId).messages.find((m) => m.id === partial.message.id);
  assert.equal(cleared.state, "resolved");
  assert.equal(cleared.resolution, `cleared by ${full.review.id}: member-3's full-scope supporting review of ${doc.id}@${doc.hash.slice(0, 12)} covers the scope ${partial.review.id} left unchecked`);
  assert.deepEqual(cleared.resolutionEvidence, [full.evidenceRecord.id]);
  assert.deepEqual(issuesFor(runId, doc.id), [], "the document is accepted");
  assert.deepEqual(report.loadCollaborationReport(hordeDir, runId).acceptedDocuments, [doc.id]);
  report.freezeAcceptance(hordeDir, runId);
  assert.match(fs.readFileSync(path.join(runDir, "COLLABORATION.md"), "utf8"), new RegExp(`\\[resolved\\] challenge BLOCKING[^]*?Resolution: cleared by ${full.review.id}`), "the frozen record shows the clearance as the resolution");

  // A refuting review's challenge, a hand-written challenge, and the partial reviewer's own later
  // full review are not cleared this way.
  const second = await publish(runId, runDir, "second");
  const refuted = await review(runId, "member-2", second.id, second.hash, { verdict: "refutes", unchecked: "", evidenceText: "the hash does not match" });
  await review(runId, "member-3", second.id, second.hash, { verdict: "supports", unchecked: "", evidenceText: "matches for me" });
  assert.equal(state(runId).messages.find((m) => m.id === refuted.message.id).state, "pending", "a refutation is an objection, not coverage debt");
  const third = await publish(runId, runDir, "third");
  const written = (await command(runId, "member-2", { action: "message", target: third.id, kind: "challenge", text: "wrong year" })).message;
  await review(runId, "member-3", third.id, third.hash, { verdict: "supports", unchecked: "", evidenceText: "year is right" });
  assert.equal(state(runId).messages.find((m) => m.id === written.id).state, "pending", "a member's own objection stays until its sender resolves it");
  const fourth = await publish(runId, runDir, "fourth");
  const own = await review(runId, "member-2", fourth.id, fourth.hash, { verdict: "partially-supports", unchecked: "appendix", evidenceText: "body holds" });
  await review(runId, "member-2", fourth.id, fourth.hash, { verdict: "supports", unchecked: "", evidenceText: "appendix holds too" });
  assert.equal(state(runId).messages.find((m) => m.id === own.message.id).state, "pending", "the challenger withdraws explicitly with resolve");

  // The same clearance applies to a finding.
  const f1 = await fileFinding(runId, "member-1", "The scope page lists the repository as out of scope", 1);
  const target = `F${f1.id}`;
  const scoped = await review(runId, "member-2", target, findings.findingRevision(f1), { verdict: "partially-supports", unchecked: "the mirror sites", evidenceText: "live page read" });
  assert.equal(findings.findingReviewState(f1, state(runId).reviews, state(runId).messages).status, "disputed");
  await review(runId, "member-4", target, findings.findingRevision(f1), { verdict: "supports", unchecked: "", evidenceText: "live page and both mirrors read" });
  assert.equal(state(runId).messages.find((m) => m.id === scoped.message.id).state, "resolved");
  assert.equal(findings.findingReviewState(f1, state(runId).reviews, state(runId).messages).status, "full");
}

// ---- C. review citations are judged per sentence ---------------------------------------------------
{
  const runId = "20261019-500003";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "The public integration script embeds the kit's callback", 2);
  const first = (await review(runId, "member-2", `F${f1.id}`, findings.findingRevision(f1), { verdict: "supports", unchecked: "", evidenceText: "script retrieved and hashed" })).review;
  const doc = await publish(runId, runDir, "integration");
  const docReview = (await review(runId, "member-3", doc.id, doc.hash, { verdict: "supports", unchecked: "", evidenceText: "document read" })).review;
  const run = { hordeDir, id: runId, cwd, runDir };
  const list = findings.listFindingsForRun(hordeDir, runId);
  const cited = (text) => citations.generatedArtifactWarnings(run, "DELIVERABLE.md", text, [], list).filter((w) => w.includes("cites V"));
  assert.deepEqual(cited(`**Support: sourced, high importance.** F${f1.id} received full-scope review **${first.id}**, including a hash check. The integration assessment received document review **${docReview.id}**.`), [], "a document review in the next sentence is not claimed for the finding");
  assert.deepEqual(cited(`F${f1.id} is confirmed by ${docReview.id}.`), [`DELIVERABLE.md cites ${docReview.id} next to F${f1.id}, but ${docReview.id} reviews ${doc.id}`], "the same sentence is still checked");
  assert.deepEqual(cited(`F${f1.id} received ${first.id} (reproduced). ${docReview.id} covers the write-up.`), [], "a sentence that starts with the review id is its own unit");
  assert.deepEqual(cited(`F${f1.id} holds, see ${first.id}; ${docReview.id} reviewed the document in the same breath.`), [`DELIVERABLE.md cites ${docReview.id} next to F${f1.id}, but ${docReview.id} reviews ${doc.id}`], "a semicolon does not end a sentence");
}

console.log(`PASS: horde-postmortem-issue15-test (fixtures retained in ${cwd})`);
