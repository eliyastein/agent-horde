// Further regressions for issue #37 (acceptance and review bookkeeping around artifacts):
// A. a V# cited for an artifact must review its current revision, also in a sentence with no F#
// B. a deliverable that cites an unaccepted artifact without saying so is warned
// C. the verifier's idea claims wait for the artifact reviews assigned to it
// D. repair serves a republish request before the reviews of the revision it replaces
// E. COLLABORATION.md marks a review of a revision its target has since left
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
const ideas = await jiti.import("../src/ledger/ideas.ts");
const protocol = await jiti.import("../src/tool/collaboration-actions.ts");
const actions = await jiti.import("../src/tool/actions.ts");
const report = await jiti.import("../src/collaboration-report.ts");
const citations = await jiti.import("../src/citations.ts");
const repair = await jiti.import("../src/run/repair.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue37-acceptance-"));
const hordeDir = files.initHordeDir(cwd);
let call = 0;
const command = async (runId, actor, params) =>
  JSON.parse((await protocol.runCollaborationAction({ hordeDir, runId, actor, attempt: "a1", requestId: `call-${++call}` }, params)).text);
const makeRun = async (runId) => {
  const runDir = path.join(hordeDir, "runs", runId);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 4\n");
  await board.appendRunHeading(hordeDir, runId, `issue 37 acceptance fixture ${runId}`);
  return runDir;
};
const document = { artifactKind: "document", criteria: "accurate and sourced" };
const publish = async (runId, runDir, name, body = "findings and method") => {
  fs.writeFileSync(path.join(runDir, `artifacts/${name}.md`), `# ${name}\n\n${body}\n`);
  return (await command(runId, "member-1", { action: "artifact", artifactPath: `artifacts/${name}.md`, ...document })).artifact;
};
const republish = async (runId, runDir, name, earlier, body) => {
  fs.writeFileSync(path.join(runDir, `artifacts/${name}.md`), `# ${name}\n\n${body}\n`);
  return (await command(runId, "member-1", { action: "artifact", target: earlier.id, revision: earlier.hash, artifactPath: `artifacts/${name}.md`, ...document })).artifact;
};
const review = async (runId, actor, target, revision) =>
  (await command(runId, actor, { action: "review", target, revision, support: "sourced", checked: "the stated scope", verdict: "supports", unchecked: "", evidenceText: "read in full", text: "review" })).review;
let concernN = 0;
const fileFinding = async (runId, author, text) =>
  (await findings.addFinding(hordeDir, runId, author, text, { concern: `acceptance-${++concernN}`, concernDef: `component ${concernN}`, concernNew: true })).finding;
const warningsFor = (runId, runDir, text, list = []) => citations.generatedArtifactWarnings({ hordeDir, id: runId, cwd, runDir }, "DELIVERABLE.md", text, [], list);

// ---- A. artifact reviews are revision-checked ----------------------------------------------------
{
  const runId = "20261119-140001";
  const runDir = await makeRun(runId);
  const first = await publish(runId, runDir, "summary");
  const early = await review(runId, "member-2", first.id, first.hash);
  const cited = (text, list) => warningsFor(runId, runDir, text, list).filter((w) => w.includes("cites V"));
  assert.deepEqual(cited(`The summary ${first.id} was reviewed in ${early.id}.`), [], "a review of the current revision is support");
  const second = await republish(runId, runDir, "summary", first, "findings, method and a third candidate");
  assert.deepEqual(cited(`The summary ${second.id} was reviewed in ${early.id}.`),
    [`DELIVERABLE.md cites ${early.id} for ${first.id}, but it reviewed an earlier revision; the current revision has no such review`]);
  const late = await review(runId, "member-3", second.id, second.hash);
  assert.deepEqual(cited(`The summary ${second.id} was reviewed in ${late.id}.`), []);

  // A sentence that names only an artifact is checked against the review's target too.
  const f1 = await fileFinding(runId, "member-4", "The health endpoint leaks the build path\nread from the source");
  const findingReview = await review(runId, "member-2", `F${f1.id}`, findings.findingRevision(f1));
  const list = findings.listFindingsForRun(hordeDir, runId);
  assert.deepEqual(cited(`The summary ${second.id} is confirmed by ${findingReview.id}.`, list),
    [`DELIVERABLE.md cites ${findingReview.id} next to ${second.id}, but ${findingReview.id} reviews F${f1.id}`]);
  assert.deepEqual(cited(`F${f1.id} and the summary ${second.id} are confirmed by ${early.id}.`, list),
    [`DELIVERABLE.md cites ${early.id} for ${second.id}, but it reviewed an earlier revision; the current revision has no such review`]);
  assert.deepEqual(cited("The engine is V8 and the paper size is A4."), [], "ids with no record are prose");
}

// ---- B. an unaccepted artifact is not presented as accepted output --------------------------------
{
  const runId = "20261119-140002";
  const runDir = await makeRun(runId);
  const accepted = await publish(runId, runDir, "accepted");
  await review(runId, "member-2", accepted.id, accepted.hash);
  const pending = await publish(runId, runDir, "pending", "draft notes");
  const unaccepted = (text) => warningsFor(runId, runDir, text).filter((w) => w.includes("does not accept"));
  assert.deepEqual(report.loadCollaborationReport(hordeDir, runId).acceptedArtifacts, [accepted.id]);
  assert.deepEqual(unaccepted(`Use ${accepted.id} as the operator playbook.`), []);
  assert.deepEqual(unaccepted(`Use ${accepted.id} and ${pending.id} as the operator playbooks.`),
    [`DELIVERABLE.md cites artifacts ACCEPTANCE.md does not accept (${pending.id}) without saying so in the citing paragraph`]);
  assert.deepEqual(unaccepted(`Use ${accepted.id}.\n\n${pending.id} is pending review and is listed for reference only.`), [], "a label in the citing paragraph is enough");
  assert.deepEqual(unaccepted(`This document lists pending work.\n\nUse ${pending.id} as the playbook.`).length, 1, "a label elsewhere does not cover the citation");
  assert.deepEqual(unaccepted("Nothing is cited here."), []);
  assert.deepEqual(citations.generatedArtifactWarnings({ cwd, runDir }, "DELIVERABLE.md", `Use ${pending.id}.`, []), [], "without a run there is no acceptance to consult");
}

// ---- C. the verifier reviews its assigned artifacts before claiming ideas -------------------------
{
  const runId = "20261119-140003";
  const runDir = await makeRun(runId);
  const doc = await publish(runId, runDir, "playbook");
  const spare = (await ideas.addIdea(hordeDir, "member-2", "trace the websocket upgrade path for header reuse")).idea;
  const claim = (role) => actions.runHordeAction(hordeDir, "member-3", { action: "claim", id: spare.id }, runId, { attempt: "a1", requestId: `act-${++call}`, role });
  await claim("verifier: reproduce other members' findings");
  await ideas.dropIdea(hordeDir, "member-3", spare.id, "released for the test");
  await command(runId, "parent", { action: "message", kind: "review-request", target: doc.id, to: "member-3", text: "independently check the playbook" });
  await assert.rejects(claim("verifier: reproduce other members' findings"), new RegExp(`you are the verifier and 1 artifact review\\(s\\) assigned to you are open: ${doc.id}\\. Review each`));
  await claim("no role");
  await ideas.dropIdea(hordeDir, "member-3", spare.id, "released for the test");
  await review(runId, "member-3", doc.id, doc.hash);
  const claimed = await claim("verifier: reproduce other members' findings");
  assert.match(claimed.text, new RegExp(`Claimed #${spare.id}`), "the review closes the assignment and frees the verifier");
}

// ---- D. a republish request is served before the reviews it would invalidate ----------------------
{
  const msg = (extra) => ({ sender: "member-2", kind: "question", target: "F1", state: "pending", blocking: false, ...extra });
  const repin = msg({ sender: "parent", kind: "handoff", target: "A3" });
  const reviewRequest = msg({ sender: "parent", kind: "review-request", target: "A3" });
  const blocker = msg({ kind: "challenge", blocking: true });
  const answer = msg({ target: "answer" });
  const responded = msg({ state: "responded" });
  const order = [responded, reviewRequest, msg({}), repin, answer, blocker].sort((a, b) => repair.repairPriority(a) - repair.repairPriority(b));
  assert.deepEqual(order.slice(0, 2).map((m) => repair.repairPriority(m)), [0, 0], "blockers and the answer still come first");
  assert.equal(order[2], repin, "then the republish against a moved dependency");
  assert.equal(order[3], reviewRequest, "then the review of what will ship");
  assert.equal(order[4], responded);
  assert.ok(repair.repairPriority(msg({ kind: "handoff", target: "A3" })) > repair.repairPriority(reviewRequest), "a member's own handoff is administrative");
  assert.ok(repair.repairPriority({ ...repin, state: "responded" }) > repair.repairPriority(reviewRequest), "an answered republish request no longer leads");
}

// ---- E. COLLABORATION.md marks reviews of an earlier revision -------------------------------------
{
  const runId = "20261119-140005";
  const runDir = await makeRun(runId);
  const first = await publish(runId, runDir, "report");
  const early = await review(runId, "member-2", first.id, first.hash);
  const second = await republish(runId, runDir, "report", first, "findings, method and limits");
  const late = await review(runId, "member-3", second.id, second.hash);
  const f1 = await fileFinding(runId, "member-4", "The metrics endpoint is unauthenticated\nread from the source");
  const before = await review(runId, "member-2", `F${f1.id}`, findings.findingRevision(f1));
  await findings.amendFinding(hordeDir, runId, "member-4", { id: f1.id, text: "The metrics endpoint is unauthenticated\nonly when the debug flag is set", note: "scope" });
  report.freezeAcceptance(hordeDir, runId);
  const markdown = fs.readFileSync(path.join(runDir, "COLLABORATION.md"), "utf8");
  const line = (id) => markdown.split("\n").find((entry) => entry.startsWith(`- ${id} `));
  assert.match(line(early.id), new RegExp(` EARLIER REVISION \\(current @${second.hash.slice(0, 12)}\\)$`));
  assert.doesNotMatch(line(late.id), /EARLIER REVISION/);
  const amended = findings.findingRevision(findings.listFindingsForRun(hordeDir, runId)[0]);
  assert.match(line(before.id), new RegExp(` EARLIER REVISION \\(current @${amended.slice(0, 12)}\\)$`));
}

console.log("issue 37 acceptance regressions passed");
