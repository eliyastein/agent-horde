// Regressions for issue #14 (post-mortem follow-ups):
// - done/drop/rule-out take the result from `note` when `text` is absent
// - a resource without text is told where the name goes
// - the member that added an unclaimed idea can drop it
// - a ref naming the E# of the event that recorded a V#, A# or Q# is told what to cite
// - a deliverable citing a project file by bare name is not warned about a missing path
// - every confirm-solved is recorded; the report names the credited and the additional confirmers
// - repair shares follow demand: review requests and blockers weigh, handoffs do not
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
const citations = await jiti.import("../src/citations.ts");
const events = await jiti.import("../src/ledger/events.ts");
const metrics = await jiti.import("../src/ledger/event-metrics.ts");
const graphs = await jiti.import("../src/run-graph.ts");
const prompt = await jiti.import("../src/prompt.ts");
const repair = await jiti.import("../src/run/repair.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue14-"));
const hordeDir = files.initHordeDir(cwd);
let call = 0;
const command = async (runId, actor, params) =>
  JSON.parse((await protocol.runCollaborationAction({ hordeDir, runId, actor, attempt: "a1", requestId: `call-${++call}` }, params)).text);
const act = (runId, member, params) => actions.runHordeAction(hordeDir, member, params, runId);
const makeRun = async (runId, members = 3) => {
  const runDir = path.join(hordeDir, "runs", runId);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), `Members: ${members}\n`);
  await board.appendRunHeading(hordeDir, runId, `issue 14 fixture ${runId}`);
  return runDir;
};
const fileFinding = async (runId, author, text, n, meta = {}) =>
  (await findings.addFinding(hordeDir, runId, author, text, { concern: `concern-${n}`, concernDef: `component ${n}`, concernNew: true, ...meta })).finding;
const ideaById = (id) => ideas.listIdeas(hordeDir).find((idea) => idea.id === id);

// ---- A. done/drop/rule-out take the result from `note`; a resource without text names the field ----
{
  const runId = "20261019-400001";
  await makeRun(runId);
  const first = await act(runId, "member-1", { action: "idea", text: "probe the ledger validator for a missing cross-file check" });
  await act(runId, "member-1", { action: "claim", id: first.id });
  await act(runId, "member-1", { action: "done", id: first.id, note: "F1: both validators pass with no ledger unit" });
  assert.equal(ideaById(first.id).note, "F1: both validators pass with no ledger unit", "the result line survives when it was passed as note");
  const second = await act(runId, "member-2", { action: "idea", text: "probe the report generator for severity overstatement" });
  await act(runId, "member-2", { action: "claim", id: second.id });
  await act(runId, "member-2", { action: "done", id: second.id, text: "F2 filed", note: "ignored when text is given" });
  assert.equal(ideaById(second.id).note, "F2 filed", "text still wins over note");
  const third = await act(runId, "member-3", { action: "idea", text: "probe the schema for a proof field" });
  await act(runId, "member-3", { action: "rule-out", id: third.id, note: "no such field exists" });
  assert.equal(ideaById(third.id).note, "no such field exists");
  assert.equal(ideaById(third.id).mark, "!");
  await assert.rejects(
    act(runId, "member-1", { action: "resource", note: "artifacts/provenance/reproduce.cjs builds ledger/findings pairs" }),
    /horde: resource needs its name in text \(note holds the reuse pointer\)/,
  );
  const claimed = await act(runId, "member-1", { action: "resource", text: "provenance harness", note: "artifacts/provenance/reproduce.cjs" });
  assert.match(claimed.text, /Claimed resource R\d+ "provenance harness"/);
}

// ---- B. the member that added an unclaimed idea can drop it ------------------------------------------
{
  const runId = "20261019-400002";
  await makeRun(runId);
  const mine = await act(runId, "member-1", { action: "idea", text: "findings validator bypass with a one-entry sink trace" });
  await assert.rejects(
    act(runId, "member-2", { action: "drop", id: mine.id, text: "not mine" }),
    new RegExp(`idea #${mine.id} is not claimed; only the member who added it or its claimant can drop it`),
  );
  const dropped = await act(runId, "member-1", { action: "drop", id: mine.id, note: "duplicate of #1; folding into it" });
  assert.match(dropped.text, new RegExp(`Dropped #${mine.id}`));
  assert.equal(ideaById(mine.id).owner, undefined);
  assert.match(fs.readFileSync(files.hordePaths(hordeDir).board, "utf8"), new RegExp(`dropped #${mine.id}: duplicate of #1; folding into it`), "the drop reason is on the board");
  const theirs = await act(runId, "member-2", { action: "idea", text: "coverage ledger validator bypass with a fabricated unit" });
  await act(runId, "member-3", { action: "claim", id: theirs.id });
  await assert.rejects(act(runId, "member-2", { action: "drop", id: theirs.id, text: "mine originally" }), /is claimed by member-3; you can only drop ideas you claimed/, "an author cannot drop an idea someone else holds");
}

// ---- C. a ref naming the E# of a review, artifact or message event is told what to cite -------------
{
  const runId = "20261019-400003";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "Sink at src/c.ts renders the manifest name", 1);
  const target = `F${f1.id}`;
  const prior = (await command(runId, "member-2", { action: "attach", target, relation: "supports", text: "rerun once" })).evidenceRecord;
  const review = (await command(runId, "member-2", { action: "review", target, revision: findings.findingRevision(f1), verdict: "supports", support: "reproduced", checked: "the sink", unchecked: "", refs: [prior.id], text: "holds" })).review;
  const reviewEvent = `E${review.id.slice(1)}`;
  await assert.rejects(
    command(runId, "member-3", { action: "message", target, kind: "question", text: "see the review", refs: [reviewEvent] }),
    new RegExp(`${reviewEvent} is the event that recorded ${review.id}, not evidence; cite ${review.id}'s evidence instead: ${prior.id}`),
  );
  fs.writeFileSync(path.join(runDir, "artifacts/poc.md"), "# POC\n\nsteps\n");
  const artifact = (await command(runId, "member-1", { action: "artifact", artifactPath: "artifacts/poc.md", artifactKind: "document", criteria: "accurate" })).artifact;
  const artifactEvent = `E${artifact.id.slice(1)}`;
  await assert.rejects(
    command(runId, "member-3", { action: "message", target: artifact.id, kind: "question", text: "see the artifact", refs: [artifactEvent] }),
    new RegExp(`${artifactEvent} is the event that recorded ${artifact.id}, not evidence; attach evidence to ${artifact.id} first, or name ${artifact.id} as the target`),
  );
  const question = (await command(runId, "member-3", { action: "message", target, kind: "question", text: "which origin?", refs: [prior.id] })).message;
  const questionEvent = `E${question.id.slice(1)}`;
  await assert.rejects(
    command(runId, "member-1", { action: "respond", target: question.id, revision: findings.findingRevision(f1), text: "the deployed one", refs: [questionEvent] }),
    new RegExp(`${questionEvent} is the event that recorded ${question.id}, not evidence; cite the evidence on ${question.id} instead: ${prior.id}`),
  );
  await assert.rejects(command(runId, "member-3", { action: "message", target, kind: "question", text: "nothing there", refs: ["E999999"] }), /horde: unknown evidence E999999$/, "an E# that recorded nothing keeps the bare error");
}

// ---- D. a deliverable citing a project file by bare name is not warned about a missing path ---------
{
  const runId = "20261019-400004";
  const runDir = await makeRun(runId);
  fs.mkdirSync(path.join(cwd, "skills/security-audit"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "skills/security-audit/SKILL.md"), "# skill\n");
  fs.mkdirSync(path.join(cwd, "node_modules/pkg"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "node_modules/pkg/VENDORED.md"), "# vendored\n");
  const run = { hordeDir, id: runId, cwd, runDir };
  const pathWarnings = (text) => citations.generatedArtifactWarnings(run, "DELIVERABLE.md", text, [], []).filter((w) => w.includes("path that does not exist"));
  assert.deepEqual(pathWarnings("The gate in SKILL.md checks shape only."), [], "a bare name found in the project tree is not missing");
  assert.deepEqual(pathWarnings("The gate in MISSING.md checks shape only."), ["DELIVERABLE.md cites a path that does not exist: MISSING.md"]);
  assert.deepEqual(pathWarnings("See VENDORED.md for the dependency."), ["DELIVERABLE.md cites a path that does not exist: VENDORED.md"], "node_modules is not searched");
}

// ---- E. every confirm-solved is recorded; the report names credited and additional confirmers --------
{
  const runId = "20261019-400005";
  const runDir = await makeRun(runId);
  await act(runId, "member-1", { action: "solved", text: "The repo is out of scope and the gate proves shape, not impact." });
  const credited = await act(runId, "member-2", { action: "confirm-solved", text: "reproduced the gate bypass" });
  assert.equal(credited.confirmation, "credited");
  const additional = await act(runId, "member-3", { action: "confirm-solved", text: "verifier: ran every runnable artifact" });
  assert.equal(additional.confirmation, "additional");
  assert.match(additional.text, /already validated by member-2/);
  const log = events.readEvents(hordeDir, runId);
  const confirmations = log.filter((e) => e.action === "confirm-solved" && e.outcome !== "intent");
  assert.deepEqual(confirmations.map((e) => [e.actor, e.outcome]), [["member-2", "applied"], ["member-3", "applied"]]);
  assert.equal(confirmations[1].payload.input.text, "verifier: ran every runnable artifact", "the later confirmation keeps its text in the event");
  assert.deepEqual(metrics.solvedConfirmations(log), { credited: ["member-2"], additional: ["member-3"] });
  assert.match(fs.readFileSync(files.hordePaths(hordeDir).board, "utf8"), /### [0-9:]+ member-3\nalso validated SOLVED: verifier: ran every runnable artifact/);
  const graph = graphs.buildRunGraph({ runId, events: log });
  const later = graph.nodes.find((n) => n.action === "confirm-solved" && n.lane === "member-3");
  assert.equal(later.outcome, "applied");
  assert.ok(graph.edges.some((edge) => edge.from === later.id && edge.label === "confirms (additional)"));
  const member = { name: "member-1", index: 1, status: "done", turns: 1, toolCalls: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, lastText: "", finalText: "", startedAt: Date.now() };
  const report = prompt.runReportMarkdown({
    id: runId, prompt: "p", count: 3, members: [member], startedAt: Date.now(), stopped: false, outcome: "completed",
    findings: [], clusters: [], claims: [], facts: [], resources: [],
    solved: { member: "member-1", text: "answer", at: new Date().toISOString() }, solvedValidatedBy: "member-2",
    solvedConfirmations: metrics.solvedConfirmations(log),
  });
  assert.match(report, /- confirm-solved: credited member-2; also confirmed by member-3/);
  assert.ok(!report.includes("redundant"), "no confirmer is called redundant");
  assert.ok(fs.existsSync(path.join(runDir, "ANSWER.md")));
}

// ---- F. repair shares follow demand ------------------------------------------------------------------
{
  const review = (target) => ({ kind: "review-request", target, blocking: false });
  const handoff = { kind: "handoff", target: "F1", blocking: false };
  const challenge = { kind: "challenge", target: "A2", blocking: true };
  assert.equal(repair.repairDemand([]), 1, "an empty queue is still one cold session");
  assert.equal(repair.repairDemand([handoff, handoff, handoff, handoff, handoff, handoff, handoff]), 1, "seven handoffs fit in one floor");
  assert.equal(repair.repairDemand([review("A1"), handoff]), 1, "the first review is covered by the floor");
  assert.equal(repair.repairDemand([review("A1"), review("F3"), challenge]), 3, "each further check is a unit");
  assert.equal(repair.repairDemand([review("I4")]), 1, "a review request on an idea is administrative");
  assert.equal(repair.repairShare(100_000, 4, 0, 3), 75_000, "a three-unit queue takes three quarters of what four units share");
  assert.equal(repair.repairShare(100_000, 4, 0, 1), 25_000);
  assert.equal(repair.repairShare(50_000, 2, 3), 12_500, "the default unit keeps the former share");
  assert.equal(repair.repairTimeShare(120_000, 4, 0, 10, 3), 90_000);
  assert.equal(repair.repairTimeShare(120_000, 4, 0, 1, 3), 120_000, "a share never exceeds the clock");
}

console.log(`PASS: horde-postmortem-issue14-test (fixtures retained in ${cwd})`);
