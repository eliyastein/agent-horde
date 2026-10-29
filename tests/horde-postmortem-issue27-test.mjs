// Regression for issue #27: a blocking request from the target's owner resolves on the recipient's
// supporting review of the current revision, since the owner may not review its own work. Before
// this, such a request could be resolved by nobody and froze the artifact's acceptance.
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
const collab = await jiti.import("../src/ledger/collaboration.ts");
const protocol = await jiti.import("../src/tool/collaboration-actions.ts");
const report = await jiti.import("../src/collaboration-report.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue27-"));
const hordeDir = files.initHordeDir(cwd);
const runId = "20261021-133359";
const runDir = path.join(hordeDir, "runs", runId);
fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 4\n");
await board.appendRunHeading(hordeDir, runId, "issue 27 fixture");

let call = 0;
const command = async (actor, params) =>
  JSON.parse((await protocol.runCollaborationAction({ hordeDir, runId, actor, attempt: "a1", requestId: `call-${++call}` }, params)).text);
const refused = (actor, params, pattern) =>
  assert.rejects(command(actor, params), (error) => { assert.match(error.message, pattern); return true; });
const publish = async (name, body, previous) => {
  fs.writeFileSync(path.join(runDir, `artifacts/${name}.md`), body);
  const revision = previous ? { target: previous.id, revision: previous.hash } : {};
  return (await command("member-1", { action: "artifact", ...revision, artifactPath: `artifacts/${name}.md`, artifactKind: "document", criteria: "accurate and sourced" })).artifact;
};
const review = (actor, target, revision, extra) =>
  command(actor, { action: "review", target, revision, support: "sourced", checked: "the stated scope", text: "review", ...extra });
const request = async (target, to) =>
  (await command("member-1", { action: "message", target, to, kind: "review-request", blocking: true, text: "please re-review the corrected revision" })).message;
const messageState = (id) => collab.collaborationState(hordeDir, runId).messages.find((m) => m.id === id).state;
const issues = (id) => report.loadCollaborationReport(hordeDir, runId).issues.filter((issue) => issue.startsWith(`${id}@`));

// ---- A. the owner's blocking review-request resolves on the recipient's full supporting review ----
{
  const doc = await publish("report", "# report\n\nv1\n");
  const q = await request(doc.id, "member-2");
  assert.equal(q.blocking, true);
  assert.match(issues(doc.id)[0], new RegExp(`blocked by ${q.id}`));
  await refused("member-1", { action: "review", target: doc.id, revision: doc.hash, verdict: "supports", unchecked: "", support: "sourced", checked: "all", text: "mine", evidenceText: "self-check" },
    /an independent review needs another member/);

  const partial = await review("member-2", doc.id, doc.hash, { verdict: "supports", unchecked: "appendix", evidenceText: "body checked" });
  await command("member-2", { action: "respond", target: q.id, revision: doc.hash, text: "body holds, appendix unchecked" });
  await refused("member-1", { action: "resolve", target: q.id, refs: [partial.evidenceRecord.id], text: "thanks" },
    new RegExp(`${doc.id} is yours, so ${q.id} resolves on member-2's review: ${partial.review.id} left unchecked: appendix`));

  const full = await review("member-2", doc.id, doc.hash, { verdict: "supports", unchecked: "", evidenceText: "appendix checked too" });
  const resolved = await command("member-1", { action: "resolve", target: q.id, refs: [full.evidenceRecord.id], text: "re-review complete" });
  assert.equal(resolved.transition.state, "resolved");
  assert.equal(messageState(q.id), "resolved");
  assert.deepEqual(issues(doc.id), [], "the resolved request no longer blocks acceptance");
  assert.deepEqual(report.loadCollaborationReport(hordeDir, runId).acceptedDocuments, [doc.id]);
}

// ---- B. before the recipient reviews, the refusal names the missing review; no one else's stands in ----
{
  const doc = await publish("second", "# second\n\nv1\n");
  const q = await request(doc.id, "member-3");
  const evidence = (await command("member-3", { action: "attach", target: doc.id, relation: "supports", text: "read in full" })).evidenceRecord;
  await command("member-3", { action: "respond", target: q.id, revision: doc.hash, text: "looks right" });
  const missing = new RegExp(`no supporting review of ${doc.id}@${doc.hash.slice(0, 12)} by member-3 yet; ask member-3 to review`);
  await refused("member-1", { action: "resolve", target: q.id, refs: [evidence.id], text: "done" }, missing);
  await review("member-4", doc.id, doc.hash, { verdict: "supports", unchecked: "", evidenceText: "checked by a bystander" });
  await refused("member-1", { action: "resolve", target: q.id, refs: [evidence.id], text: "done" }, missing);
  const refuting = await review("member-3", doc.id, doc.hash, { verdict: "refutes", unchecked: "", evidenceText: "table 2 is wrong" });
  await refused("member-1", { action: "resolve", target: q.id, refs: [evidence.id], text: "done" }, new RegExp(`${refuting.review.id} is refutes, not supports`));
  await review("member-3", doc.id, doc.hash, { verdict: "supports", unchecked: "", evidenceText: "table 2 re-read, it holds" });
  await command("member-1", { action: "resolve", target: q.id, refs: [evidence.id], text: "done" });
  assert.equal(messageState(q.id), "resolved");
}

// ---- C. a review of an older revision does not resolve a request about the current one ----
{
  const v1 = await publish("third", "# third\n\nv1\n");
  await review("member-2", v1.id, v1.hash, { verdict: "supports", unchecked: "", evidenceText: "v1 checked" });
  const v2 = await publish("third", "# third\n\nv2\n", v1);
  assert.notEqual(v2.hash, v1.hash);
  const q = await request(v2.id, "member-2");
  const evidence = (await command("member-2", { action: "attach", target: v2.id, relation: "supports", text: "v2 re-read" })).evidenceRecord;
  await command("member-2", { action: "respond", target: q.id, revision: v2.hash, text: "unchanged in substance" });
  await refused("member-1", { action: "resolve", target: q.id, refs: [evidence.id], text: "done" },
    new RegExp(`no supporting review of ${v2.id}@${v2.hash.slice(0, 12)} by member-2 yet`));
  await command("member-2", { action: "reattest", target: v2.id, revision: v2.hash, refs: [evidence.id], text: "what I checked is unchanged" });
  await command("member-1", { action: "resolve", target: q.id, refs: [evidence.id], text: "done" });
  assert.equal(messageState(q.id), "resolved");
}

// ---- D. a challenger still settles its own dispute with its own review ----
{
  const doc = await publish("fourth", "# fourth\n\nv1\n");
  const challenge = (await command("member-2", { action: "message", target: doc.id, kind: "challenge", text: "wrong year" })).message;
  assert.equal(challenge.blocking, true);
  const evidence = (await command("member-1", { action: "attach", target: doc.id, relation: "supports", text: "year verified against the source" })).evidenceRecord;
  await command("member-1", { action: "respond", target: challenge.id, revision: doc.hash, text: "the year is right" });
  await review("member-3", doc.id, doc.hash, { verdict: "supports", unchecked: "", evidenceText: "year checked" });
  await refused("member-2", { action: "resolve", target: challenge.id, refs: [evidence.id], text: "ok" }, /resolve requires your supporting review of the current revision/);
  await review("member-2", doc.id, doc.hash, { verdict: "supports", unchecked: "", evidenceText: "year checked by me" });
  await command("member-2", { action: "resolve", target: challenge.id, refs: [evidence.id], text: "ok" });
  assert.equal(messageState(challenge.id), "resolved");
}

console.log(`PASS: horde-postmortem-issue27-test (fixtures retained in ${cwd})`);
