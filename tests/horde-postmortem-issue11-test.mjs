// Regressions for issue #11 (post-mortem follow-ups):
// - a message cannot be addressed to its sender; a review request on your own artifact names another member
// - the REPORT.md ranked and superseded headlines are bounded
// - a missing artifactPath is a horde error that says where artifacts live
// - a ref naming a V# is told to cite the review's evidence
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
const clusters = await jiti.import("../src/ledger/clusters.ts");
const protocol = await jiti.import("../src/tool/collaboration-actions.ts");
const inbox = await jiti.import("../src/tool/inbox.ts");
const prompt = await jiti.import("../src/prompt.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue11-"));
const hordeDir = files.initHordeDir(cwd);
let call = 0;
const command = async (runId, actor, params) =>
  JSON.parse((await protocol.runCollaborationAction({ hordeDir, runId, actor, attempt: "a1", requestId: `call-${++call}` }, params)).text);
const makeRun = async (runId, members = 3) => {
  const runDir = path.join(hordeDir, "runs", runId);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), `Members: ${members}\n`);
  await board.appendRunHeading(hordeDir, runId, `issue 11 fixture ${runId}`);
  return runDir;
};
const fileFinding = async (runId, author, text, n, meta = {}) =>
  (await findings.addFinding(hordeDir, runId, author, text, { concern: `concern-${n}`, concernDef: `component ${n}`, concernNew: true, ...meta })).finding;

// ---- A. a message cannot be addressed to its sender -------------------------------------------------
{
  const runId = "20261019-300001";
  const runDir = await makeRun(runId);
  fs.writeFileSync(path.join(runDir, "artifacts/poc.md"), "# POC\n\nsteps\n");
  const artifact = (await command(runId, "member-1", { action: "artifact", artifactPath: "artifacts/poc.md", artifactKind: "document", criteria: "accurate" })).artifact;
  await assert.rejects(
    command(runId, "member-1", { action: "message", target: artifact.id, kind: "review-request", text: "please review" }),
    new RegExp(`cannot be addressed to its sender; ${artifact.id} is yours, name another member with to=member-N`),
    "the default recipient of a request about your own work is yourself",
  );
  await assert.rejects(command(runId, "member-1", { action: "message", target: artifact.id, kind: "question", to: "member-1", text: "note to self" }), /cannot be addressed to its sender/);
  const sent = (await command(runId, "member-1", { action: "message", target: artifact.id, kind: "review-request", to: "member-2", text: "please review" })).message;
  assert.equal(sent.to, "member-2");
  assert.deepEqual(inbox.inboxFor({ hordeDir, runId, actor: "member-2" }).map((m) => m.id), [sent.id], "the named member receives it");
  assert.deepEqual(inbox.inboxFor({ hordeDir, runId, actor: "member-1" }), [], "nothing sits in the sender's own inbox");
}

// ---- B. the ranked and superseded headlines are bounded ---------------------------------------------
{
  const runId = "20261019-300002";
  await makeRun(runId);
  const body = "Shipped-package audit result: no default-config sink found at this revision, so the only reproduced sink is in the sandbox. " +
    "Sink inventory with the reason each is closed: (1) the attribute renderer escapes values but not names, which stays closed because names come from the caller; " +
    "(2) the error overlay sets textContent; (3) the manifest parser copies labels into state that the sandbox, not the package, renders; " +
    "(4) the plugin loader validates the scheme before building the iframe source, which closes the javascript: path.";
  assert.ok(body.length > 400 && !body.includes("\n"), "a single-paragraph finding is its own title");
  const long = await fileFinding(runId, "member-1", body, 1);
  const successor = await fileFinding(runId, "member-1", `${body} Superseding note.`, 1, { supersedes: long.id });
  const list = findings.listFindingsForRun(hordeDir, runId);
  const member = { name: "member-1", index: 1, status: "done", turns: 1, toolCalls: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, lastText: "", finalText: "", startedAt: Date.now() };
  const report = prompt.runReportMarkdown({
    id: runId, prompt: "p", count: 1, members: [member], startedAt: Date.now(), stopped: false, outcome: "completed",
    findings: list, clusters: clusters.clusterFindings(list), claims: [], facts: [], resources: [],
  });
  const reportLines = report.split("\n");
  const headline = reportLines.find((line) => line.startsWith("1. "));
  assert.ok(headline, "the ranked list has a headline");
  assert.ok(headline.length < 200, `the headline is bounded: ${headline.length} chars`);
  assert.ok(!headline.includes("plugin loader"), "the tail of the paragraph is not in the headline");
  assert.match(headline, /\(members: member-1; 2 entries\)$/);
  // The successor shares the superseded finding's cluster; it must still rank, not vanish with its root.
  assert.ok(reportLines.some((line) => line.startsWith(`   - F${successor.id} `) && line.includes("review=unreviewed")), "the superseding finding is in the ranked list");
  const superseded = reportLines.find((line) => line.startsWith(`- F${long.id} (superseded by F${successor.id}):`));
  assert.ok(superseded, "the superseded list names the pair");
  assert.ok(superseded.length < 220, `the superseded headline is bounded: ${superseded.length} chars`);
  assert.equal(reportLines.filter((line) => /^- F\d+ \(superseded by/.test(line)).length, 1);
}

// ---- C. a missing artifactPath is a horde error -----------------------------------------------------
{
  const runId = "20261019-300003";
  await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "Sink at src/a.ts renders the query string", 2);
  await assert.rejects(
    command(runId, "member-2", { action: "attach", target: `F${f1.id}`, text: "collected", artifactPath: "artifacts/verify-f1/collected.json" }),
    new RegExp(`horde: artifactPath not found: artifacts/verify-f1/collected.json; artifacts live under runs/${runId}/artifacts/`),
  );
  await assert.rejects(
    command(runId, "member-2", { action: "review", target: `F${f1.id}`, revision: findings.findingRevision(f1), verdict: "supports", support: "tested", checked: "all", unchecked: "", evidenceText: "ran", text: "ok", artifactPath: "artifacts/missing.log" }),
    /artifactPath not found: artifacts\/missing\.log/,
  );
}

// ---- D. a ref naming a V# is told to cite the review's evidence --------------------------------------
{
  const runId = "20261019-300004";
  await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "Sink at src/b.ts renders the manifest name", 3);
  const target = `F${f1.id}`;
  const prior = (await command(runId, "member-2", { action: "attach", target, relation: "supports", text: "rerun once" })).evidenceRecord;
  const reviewed = await command(runId, "member-2", { action: "review", target, revision: findings.findingRevision(f1), verdict: "supports", support: "reproduced", checked: "the sink", unchecked: "", refs: [prior.id], evidenceText: "rerun twice", text: "holds" });
  const review = reviewed.review;
  await assert.rejects(
    command(runId, "member-3", { action: "message", target, kind: "question", text: "see the review", refs: [review.id] }),
    new RegExp(`${review.id} is a review, not evidence; cite its evidence instead: ${prior.id}, ${reviewed.evidenceRecord.id}`),
  );
  await assert.rejects(command(runId, "member-3", { action: "message", target, kind: "question", text: "see F", refs: [target] }), /is not evidence, refs take E# ids/, "other ids keep the generic hint");
  const ok = (await command(runId, "member-3", { action: "message", target, kind: "question", text: "see the evidence", refs: [prior.id, reviewed.evidenceRecord.id] })).message;
  assert.deepEqual(ok.evidence, [prior.id, reviewed.evidenceRecord.id]);
}

console.log(`PASS: horde-postmortem-issue11-test (fixtures retained in ${cwd})`);
