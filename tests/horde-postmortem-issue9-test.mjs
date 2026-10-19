// Regressions for issue #9 (post-mortem follow-ups):
// - a challenger withdraws its own blocking challenge with a supporting review before any response
// - on an artifact the withdrawal tolerates disclosed limits; the responded path still needs full coverage
// - respond on a pending request implies the acknowledgement; ack stays available to signal intent
// - a V# cited next to an F# it does not review, or that reviewed an earlier revision, is warned
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
const inbox = await jiti.import("../src/tool/inbox.ts");
const citations = await jiti.import("../src/citations.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue9-"));
const hordeDir = files.initHordeDir(cwd);
let call = 0;
const command = async (runId, actor, params) =>
  JSON.parse((await protocol.runCollaborationAction({ hordeDir, runId, actor, attempt: "a1", requestId: `call-${++call}` }, params)).text);
const makeRun = async (runId, members = 3) => {
  const runDir = path.join(hordeDir, "runs", runId);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), `Members: ${members}\n`);
  await board.appendRunHeading(hordeDir, runId, `issue 9 fixture ${runId}`);
  return runDir;
};
const fileFinding = async (runId, author, text, n) =>
  (await findings.addFinding(hordeDir, runId, author, text, { concern: `concern-${n}`, concernDef: `component ${n}`, concernNew: true })).finding;
const review = (runId, actor, target, revision, { verdict, unchecked, evidenceText }) =>
  command(runId, actor, { action: "review", target, revision, verdict, support: "reproduced", checked: "the challenged claim", unchecked, evidenceText, text: `${verdict} on re-measurement` });

// ---- A. a challenger withdraws its own blocking challenge on a finding ----------------------------
{
  const runId = "20261018-200001";
  await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "Reflected sink at src/a.ts renders the raw query string", 1);
  const target = `F${f1.id}`;
  const revision = findings.findingRevision(f1);
  const challenge = (await command(runId, "member-2", { action: "message", target, kind: "challenge", text: "the payload may be encoded before the sink" })).message;
  assert.ok(challenge.blocking);
  const probe = (await command(runId, "member-2", { action: "attach", target, relation: "supports", text: "re-ran the request: the sink renders raw bytes" })).evidenceRecord;
  await assert.rejects(
    command(runId, "member-2", { action: "resolve", target: challenge.id, refs: [probe.id], text: "withdrawn" }),
    /no response yet; to withdraw your own challenge, record a supporting review/,
    "evidence alone does not withdraw a challenge",
  );
  assert.equal(report.loadCollaborationReport(hordeDir, runId).metrics.blocking, 1);
  await review(runId, "member-2", target, revision, { verdict: "supports", unchecked: "", evidenceText: "the sink renders raw bytes on a fresh session" });
  await command(runId, "member-2", { action: "resolve", target: challenge.id, refs: [probe.id], text: "withdrawn: verified the claim myself" });
  const state = collab.collaborationState(hordeDir, runId);
  assert.equal(state.messages[0].state, "resolved");
  assert.equal(state.messages[0].responseRevision, undefined, "no response was needed");
  assert.equal(report.loadCollaborationReport(hordeDir, runId).metrics.blocking, 0, "the withdrawn challenge no longer blocks");
  assert.equal(findings.findingReviewState(f1, state.reviews, state.messages).status, "full", "acceptance clears");
  assert.ok(!report.freezeAcceptance(hordeDir, runId).issues.some((issue) => issue.includes(target)));
  await assert.rejects(command(runId, "member-2", { action: "resolve", target: challenge.id, refs: [probe.id], text: "again" }), /already closed/);
}

// ---- B. on an artifact the withdrawal tolerates disclosed limits; a response does not ---------------
{
  const runId = "20261018-200002";
  const runDir = await makeRun(runId);
  fs.writeFileSync(path.join(runDir, "artifacts/poc.md"), "# POC\n\nload the manifest; preload=none does not fetch\n");
  const artifact = (await command(runId, "member-1", { action: "artifact", artifactPath: "artifacts/poc.md", artifactKind: "document", criteria: "manifest NAME renders; preload=none does not fetch" })).artifact;
  const doubt = await review(runId, "member-2", artifact.id, artifact.hash, { verdict: "partially-supports", unchecked: "preload=none appeared to fetch", evidenceText: "a request fired with preload=none" });
  assert.ok(doubt.message?.blocking, "a partial review raises a blocking challenge");
  const retraction = await review(runId, "member-2", artifact.id, artifact.hash, { verdict: "supports", unchecked: "deployed origin not exercised", evidenceText: "window.state().presentation shows no fetch with preload=none" });
  await command(runId, "member-2", { action: "resolve", target: doubt.message.id, refs: [retraction.evidenceRecord.id], text: "withdrawn: my measurement was wrong" });
  let summary = report.loadCollaborationReport(hordeDir, runId);
  assert.equal(summary.metrics.blocking, 0, "the artifact is no longer disputed");
  assert.deepEqual(summary.acceptedArtifacts, [], "the disclosed limit stays acceptance debt");

  // With a response in hand the resolver still needs full coverage before the artifact is accepted.
  const second = await review(runId, "member-2", artifact.id, artifact.hash, { verdict: "partially-supports", unchecked: "text-track branch", evidenceText: "only the audio branch was rerun" });
  await command(runId, "member-1", { action: "respond", target: second.message.id, revision: artifact.hash, text: "the text-track branch uses the same renderer" });
  await assert.rejects(
    command(runId, "member-2", { action: "resolve", target: second.message.id, refs: [second.evidenceRecord.id], text: "fine" }),
    /resolve requires your supporting review/,
  );
  const limited = await review(runId, "member-2", artifact.id, artifact.hash, { verdict: "supports", unchecked: "text-track branch", evidenceText: "audio branch rerun" });
  await assert.rejects(
    command(runId, "member-2", { action: "resolve", target: second.message.id, refs: [limited.evidenceRecord.id], text: "fine" }),
    /finding limitations remain acceptance debt/,
    "a responded artifact challenge still needs a full-coverage review",
  );
  const full = await review(runId, "member-2", artifact.id, artifact.hash, { verdict: "supports", unchecked: "", evidenceText: "both branches rerun" });
  await command(runId, "member-2", { action: "resolve", target: second.message.id, refs: [full.evidenceRecord.id], text: "both branches hold" });
  summary = report.loadCollaborationReport(hordeDir, runId);
  assert.deepEqual(summary.acceptedArtifacts, [artifact.id]);
}

// ---- C. respond on a pending request implies the acknowledgement ----------------------------------
{
  const runId = "20261018-200003";
  await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "Config path at src/c.ts is trusted at boot", 3);
  const target = `F${f1.id}`;
  const revision = findings.findingRevision(f1);
  const question = (await command(runId, "member-2", { action: "message", target, kind: "question", text: "which config file?" })).message;
  assert.equal(question.state, "pending");
  await assert.rejects(command(runId, "member-2", { action: "respond", target: question.id, revision, text: "not mine" }), /recipient acknowledges\/responds/);
  await command(runId, "member-1", { action: "respond", target: question.id, revision, text: "config/app.yaml, loaded at boot" });
  let state = collab.collaborationState(hordeDir, runId);
  assert.equal(state.messages[0].state, "responded", "a direct answer needs no prior ack");
  assert.equal(state.messages[0].response, "config/app.yaml, loaded at boot");
  assert.deepEqual(inbox.inboxFor({ hordeDir, runId, actor: "member-2" }).map((m) => m.id), [question.id], "the response returns to the sender");
  const second = (await command(runId, "member-2", { action: "message", target, kind: "question", text: "and the loader?" })).message;
  await command(runId, "member-1", { action: "ack", target: second.id, text: "checking" });
  state = collab.collaborationState(hordeDir, runId);
  assert.equal(state.messages[1].state, "acknowledged", "ack still signals intent on its own");
  await command(runId, "member-1", { action: "respond", target: second.id, revision, text: "src/loader.ts" });
  assert.equal(collab.collaborationState(hordeDir, runId).messages[1].state, "responded");
}

// ---- D. a V# cited next to an F# must review that finding at its current revision ------------------
{
  const runId = "20261018-200004";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "Sink one at src/a.ts renders the query string", 4);
  const f2 = await fileFinding(runId, "member-1", "Sink two at src/b.ts renders the manifest name", 5);
  const first = (await review(runId, "member-2", `F${f1.id}`, findings.findingRevision(f1), { verdict: "supports", unchecked: "", evidenceText: "rerun on the deployed origin" })).review;
  const early = (await review(runId, "member-2", `F${f2.id}`, findings.findingRevision(f2), { verdict: "supports", unchecked: "", evidenceText: "rerun with a planted manifest" })).review;
  fs.writeFileSync(path.join(runDir, "artifacts/poc.md"), "# POC\n\nsteps\n");
  const artifact = (await command(runId, "member-1", { action: "artifact", artifactPath: "artifacts/poc.md", artifactKind: "document", criteria: "accurate", dependsOn: [`F${f1.id}`] })).artifact;
  const doc = (await review(runId, "member-3", artifact.id, artifact.hash, { verdict: "supports", unchecked: "", evidenceText: "steps followed" })).review;
  // F2's body changes after its review, so that review no longer covers the current revision.
  const findingsPath = files.hordePaths(hordeDir).findings;
  fs.writeFileSync(findingsPath, fs.readFileSync(findingsPath, "utf8").replace("renders the manifest name", "renders the manifest NAME attribute"));
  const f3 = (await findings.addFinding(hordeDir, runId, "member-1", "Sink one at src/a.ts also renders the manifest name", { concern: "concern-4", supersedes: f1.id })).finding;
  const run = { hordeDir, id: runId, cwd, runDir };
  const list = findings.listFindingsForRun(hordeDir, runId);
  const cited = (text) => citations.generatedArtifactWarnings(run, "DELIVERABLE.md", text, [], list).filter((w) => w.includes("cites V"));
  assert.deepEqual(
    cited(`F${f3.id} supersedes F${f1.id}.\n\nSupport: F${f3.id} is confirmed by ${first.id}.`),
    [`DELIVERABLE.md cites ${first.id} next to F${f3.id}, but ${first.id} reviews F${f1.id}`],
    "a review of the superseded finding is not support for its successor",
  );
  assert.deepEqual(cited(`Support: F${f1.id} (superseded) was confirmed by ${first.id}.`), [], "the review sits next to the finding it reviews");
  assert.deepEqual(
    cited(`Support: F${f1.id} is confirmed by ${doc.id}.`),
    [`DELIVERABLE.md cites ${doc.id} next to F${f1.id}, but ${doc.id} reviews ${artifact.id}`],
    "an artifact review is not finding-level support",
  );
  assert.deepEqual(cited(`${artifact.id} depends on F${f1.id}; ${doc.id} reviewed it.`), [], "the artifact review sits next to its artifact");
  assert.deepEqual(
    cited(`F${f2.id} is confirmed by ${early.id}.`),
    [`DELIVERABLE.md cites ${early.id} for F${f2.id}, but it reviewed an earlier revision; the current revision has no such review`],
  );
  assert.deepEqual(cited(`Reviews: ${first.id}, ${early.id}, ${doc.id}.`), [], "a paragraph without a finding citation is not checked");
  assert.deepEqual(cited(`F${f1.id} runs on the V8 engine.`), [], "a V# with no review record is prose");
  // List items and table rows are judged on their own, so a bullet that cites reviews as the source
  // of a limitation is not read as support for the finding named in another bullet.
  assert.deepEqual(cited(`- F${f2.id} was not rerun on a patched build.\n- The negative control is missing (stated in ${first.id}, ${doc.id}).`), []);
  assert.deepEqual(
    cited(`| # | Issue | Review |\n|---|---|---|\n| F${f1.id} F${f1.id} | sink | ${doc.id} on artifact |\n| F${f2.id} | sink | ${early.id} |`),
    [
      `DELIVERABLE.md cites ${doc.id} next to F${f1.id}, but ${doc.id} reviews ${artifact.id}`,
      `DELIVERABLE.md cites ${early.id} for F${f2.id}, but it reviewed an earlier revision; the current revision has no such review`,
    ],
    "each table row is its own unit and repeated ids are named once",
  );
}

console.log(`PASS: horde-postmortem-issue9-test (fixtures retained in ${cwd})`);
