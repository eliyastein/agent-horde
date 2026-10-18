// Regressions for issue #7 (post-mortem follow-ups):
// - a blocking challenge deferred before any response can be answered and then resolved
// - deferred blocking debt reaches the recipient's inbox; response and resolution evidence are projected
// - a parent review request closed by a review names the V# and its evidence in COLLABORATION.md
// - a stale evidence ref names the ref and both revisions
// - two resources of one run cannot register the same cleanup object
// - the unreviewed-citation warning accepts the acceptance vocabulary next to the citation
// - resource reuse counts citing non-owners
// - redundant confirm-solved calls and absorbed idea creations record noop events, feed the report and the graph
// - ANSWER.md names superseded citations; SUMMARY.md states how the run actually ended
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
const inbox = await jiti.import("../src/tool/inbox.ts");
const report = await jiti.import("../src/collaboration-report.ts");
const citations = await jiti.import("../src/citations.ts");
const resources = await jiti.import("../src/ledger/resources.ts");
const actions = await jiti.import("../src/tool/actions.ts");
const events = await jiti.import("../src/ledger/events.ts");
const metrics = await jiti.import("../src/ledger/event-metrics.ts");
const graphs = await jiti.import("../src/run-graph.ts");
const prompt = await jiti.import("../src/prompt.ts");
const finalize = await jiti.import("../src/run/finalize.ts");
const { HordeParams } = await jiti.import("../src/tool/params.ts");
const { newMemberState } = await jiti.import("../src/member.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue7-"));
const hordeDir = files.initHordeDir(cwd);
let call = 0;
const command = async (runId, actor, params) =>
  JSON.parse((await protocol.runCollaborationAction({ hordeDir, runId, actor, attempt: "a1", requestId: `call-${++call}` }, params)).text);
const makeRun = async (runId, members = 3) => {
  const runDir = path.join(hordeDir, "runs", runId);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), `Members: ${members}\n`);
  await board.appendRunHeading(hordeDir, runId, `issue 7 fixture ${runId}`);
  return runDir;
};
const fileFinding = async (runId, author, text, n) =>
  (await findings.addFinding(hordeDir, runId, author, text, { concern: `concern-${n}`, concernDef: `component ${n}`, concernNew: true })).finding;

// ---- A. a deferred blocking challenge is debt the recipient can still answer ----------------------
{
  const runId = "20261018-100001";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "Sink one at src/a.ts follows a planted link", 1);
  const f2 = await fileFinding(runId, "member-1", "Sink two at src/b.ts trusts a config path", 2);
  const target = `F${f1.id}`;
  const revision = findings.findingRevision(f1);
  const challenge = (await command(runId, "member-2", { action: "message", target, kind: "challenge", text: "no live rerun; the secondary claim needs a test" })).message;
  assert.ok(challenge.blocking);
  await command(runId, "member-2", { action: "defer", target: challenge.id, text: "deferring as acceptance debt" });
  let state = collab.collaborationState(hordeDir, runId);
  assert.equal(state.messages[0].state, "deferred");
  assert.equal(report.loadCollaborationReport(hordeDir, runId).metrics.blocking, 1, "deferred blocking debt still blocks");
  assert.deepEqual(inbox.inboxFor({ hordeDir, runId, actor: "member-1" }).map((m) => m.id), [challenge.id], "the recipient sees the deferred debt");
  assert.deepEqual(inbox.inboxFor({ hordeDir, runId, actor: "member-2" }), [], "the sender has nothing to act on yet");
  await assert.rejects(command(runId, "member-1", { action: "ack", target: challenge.id, text: "later" }), /deferred request takes a response/);
  const answer = (await command(runId, "member-1", { action: "attach", target, relation: "supports", text: "rerun on a fresh image; both claims hold" })).evidenceRecord;
  await command(runId, "member-1", { action: "respond", target: challenge.id, revision, refs: [answer.id], text: "both sub-claims rerun" });
  state = collab.collaborationState(hordeDir, runId);
  assert.equal(state.messages[0].state, "responded");
  assert.deepEqual(state.messages[0].responseEvidence, [answer.id], "the response carries the evidence it cited");
  assert.deepEqual(inbox.inboxFor({ hordeDir, runId, actor: "member-2" }).map((m) => m.id), [challenge.id], "the responded request returns to its sender");
  // A stale ref names itself and both revisions instead of leaving the member to guess.
  await assert.rejects(
    command(runId, "member-2", { action: "review", target: `F${f2.id}`, revision: findings.findingRevision(f2), verdict: "supports", support: "tested", checked: "all", unchecked: "", refs: [answer.id], text: "wrong target" }),
    new RegExp(`${answer.id} is recorded against ${target}@[0-9a-f]{12}; the current target is F${f2.id}@[0-9a-f]{12}`),
  );
  const check = await command(runId, "member-2", { action: "review", target, revision, verdict: "supports", support: "tested", checked: "both sub-claims on a fresh image", unchecked: "", evidenceText: "independent rerun matches", text: "holds" });
  await command(runId, "member-2", { action: "resolve", target: challenge.id, revision, refs: [check.evidenceRecord.id], text: "cleared after independent rerun" });
  state = collab.collaborationState(hordeDir, runId);
  assert.equal(state.messages[0].state, "resolved");
  assert.deepEqual(state.messages[0].resolutionEvidence, [check.evidenceRecord.id]);
  const collaboration = report.loadCollaborationReport(hordeDir, runId);
  assert.equal(collaboration.metrics.blocking, 0);
  assert.equal(collaboration.metrics.resolvedChallenges, 1);
  assert.equal(collaboration.metrics.deferredChallenges, 0);
  assert.equal(collaboration.metrics.openChallenges, 0);
  assert.equal(findings.findingReviewState(f1, state.reviews, state.messages).status, "full");

  // A parent review request closes with the review id and its evidence, not with "Response: pending".
  fs.writeFileSync(path.join(runDir, "artifacts/probe.sh"), "echo ok\n");
  const artifact = (await command(runId, "member-1", { action: "artifact", artifactPath: "artifacts/probe.sh", criteria: "prints ok; prints nothing on bad input" })).artifact;
  const request = (await command(runId, "parent", { action: "message", kind: "review-request", target: artifact.id, to: "member-3", text: "check it" })).message;
  const verdict = await command(runId, "member-3", { action: "review", target: artifact.id, revision: artifact.hash, verdict: "supports", support: "tested", checked: "both controls", unchecked: "", evidenceText: "ran both controls", text: "controls pass" });
  state = collab.collaborationState(hordeDir, runId);
  const closed = state.messages.find((m) => m.id === request.id);
  assert.equal(closed.state, "resolved");
  assert.equal(closed.resolution, `Review recorded: ${verdict.review.id} controls pass`);
  assert.deepEqual(closed.resolutionEvidence, [verdict.evidenceRecord.id]);
  report.freezeAcceptance(hordeDir, runId);
  const markdown = fs.readFileSync(path.join(runDir, "COLLABORATION.md"), "utf8");
  assert.match(markdown, new RegExp(`${request.id} parent -> member-3 [^\\n]*\\[resolved\\] review-request\\n  check it\\n  Response: pending\\n  Resolution: Review recorded: ${verdict.review.id} controls pass \\(evidence ${verdict.evidenceRecord.id}\\)`));
  assert.match(markdown, new RegExp(`Response: both sub-claims rerun \\(evidence ${answer.id}\\)\\n  Resolution: cleared after independent rerun \\(evidence ${check.evidenceRecord.id}\\)`));
}

// ---- B. one teardown must not remove two labs ------------------------------------------------------
{
  const runId = "20261018-100002";
  await makeRun(runId);
  const first = (await resources.claimResource(hordeDir, "member-1", { name: "lab one", note: "debian image", cleanup: "docker rm -f shared-lab", runId })).resource;
  await assert.rejects(
    resources.claimResource(hordeDir, "member-2", { name: "debian12 lab two", note: "another image", cleanup: "docker rm --force shared-lab", runId }),
    new RegExp(`cleanup \`docker rm --force shared-lab\` is already registered by R${first.id} "lab one"; reuse R${first.id} or pick a distinct container name`),
  );
  const distinct = (await resources.claimResource(hordeDir, "member-2", { name: "debian12 lab two", note: "another image", cleanup: "docker rm -f lab-two", runId })).resource;
  assert.equal(distinct.id, first.id + 1);
  await assert.rejects(
    resources.claimResource(hordeDir, "member-2", { name: "debian12 lab two", cleanup: "docker rm -f shared-lab", runId }),
    /already registered by R\d+/,
    "an owner cannot move its cleanup onto another lab's container",
  );
  const elsewhere = (await resources.claimResource(hordeDir, "member-3", { name: "lab three", cleanup: "docker rm -f shared-lab", runId: "20261018-100003" })).resource;
  assert.equal(elsewhere.id, distinct.id + 1, "a resource of another run does not collide");
}

// ---- C. unreviewed-citation labels and reuse by citation --------------------------------------------
{
  const runId = "20261018-100004";
  const runDir = await makeRun(runId);
  const lab = (await resources.claimResource(hordeDir, "member-1", { name: "shared debian lab", note: "fixture", runId })).resource;
  const cited = await fileFinding(runId, "member-2", `Root chown follows a planted link, reproduced in R${lab.id}`, 3);
  const own = await fileFinding(runId, "member-1", `Owner note that also cites R${lab.id} for its own lab`, 4);
  const run = { hordeDir, id: runId, cwd, runDir };
  const list = findings.listFindingsForRun(hordeDir, runId);
  const unreviewed = (text) => citations.generatedArtifactWarnings(run, "DELIVERABLE.md", text, [lab], list).filter((w) => w.includes("no independent review"));
  assert.deepEqual(unreviewed(`Summary.\n\nF${cited.id} has no independent review of the current revision but the mechanism is clear.`), [], "the acceptance vocabulary next to the citation is a label");
  assert.deepEqual(unreviewed(`F${cited.id} is unreviewed.\n\nF${own.id}: not independently reviewed.`), []);
  assert.deepEqual(
    unreviewed(`Some findings are unverified.\n\nDetails.\n\nF${cited.id} settles the question.`),
    [`DELIVERABLE.md cites findings with no independent review (F${cited.id}) without saying so in the citing paragraph`],
    "a label elsewhere in the document does not cover a bare citation",
  );
  assert.deepEqual(unreviewed("Nothing cited here."), []);

  const state = {
    evidence: [{ actor: "member-3", text: `ran the harness in R${lab.id}` }],
    reviews: [{ actor: "member-1", checked: `R${lab.id}`, text: "owner" }],
    resources: [{ target: `R${lab.id}`, owner: "member-4" }],
  };
  const citing = citations.resourceCitingMembers([lab], list, state);
  assert.deepEqual(citing.get(lab.id), ["member-2", "member-3", "member-4"], "non-owner findings, evidence and leases count; the owner does not");
  const text = prompt.runReportMarkdown({
    id: runId, prompt: "p", count: 4, members: [newMemberState(1)], startedAt: Date.now(), stopped: false, outcome: "completed",
    findings: [], clusters: [], claims: [], facts: [], resources: [{ ...lab, citedBy: citing.get(lab.id) }],
  });
  assert.match(text, /- resources: 1 claimed, 1 reused \(0 explicit reclaim\(s\), 3 citing member\(s\)\)/);
  assert.match(text, new RegExp(`- R${lab.id} shared debian lab @member-1: fixture \\(cited by member-2, member-3, member-4\\)`));
}

// ---- D. no-op outcomes, event metrics, the graph, and finalize accounting ---------------------------
{
  const runId = "20261018-100005";
  const runDir = await makeRun(runId);
  const act = (member, params) => actions.runHordeAction(hordeDir, member, params, runId);
  const added = await act("member-1", { action: "idea", text: "probe the login form for symlink handling" });
  assert.match(added.text, /Added idea/);
  const absorbed = await act("member-2", { action: "idea", text: "probe the login form for symlink handling" });
  assert.match(absorbed.text, /already exists as/);
  const f1 = await fileFinding(runId, "member-1", "Root reads a config path from a writable file", 5);
  const f2 = (await findings.addFinding(hordeDir, runId, "member-1", "Correction: the config path read needs no symlink at all", { concern: "concern-5", supersedes: f1.id })).finding;
  await act("member-1", { action: "solved", text: `Chain: F${f1.id} gives the read, F${f2.id} removes the symlink requirement.` });
  await act("member-2", { action: "confirm-solved", text: "reproduced" });
  const redundant = await act("member-3", { action: "confirm-solved", text: "me too" });
  assert.match(redundant.text, /already validated by member-2/);
  const log = events.readEvents(hordeDir, runId);
  const settled = (action, actor) => log.find((e) => e.action === action && e.actor === actor && e.outcome !== "intent");
  const absorbedEvent = settled("idea", "member-2");
  assert.equal(absorbedEvent.outcome, "noop");
  assert.equal(absorbedEvent.payload.result.noop, true);
  assert.equal(absorbedEvent.payload.result.id, added.id);
  assert.equal(settled("confirm-solved", "member-2").outcome, "applied");
  assert.equal(settled("confirm-solved", "member-3").outcome, "noop");
  assert.deepEqual(metrics.solvedConfirmations(log), { credited: ["member-2"], redundant: ["member-3"] });
  assert.equal(metrics.ideaCreationCount(log), 1);
  assert.deepEqual(metrics.absorbedIdeaCreations(log), [{ id: added.id, count: 1 }]);
  // The graph draws a repeat as a marker pointing at what it repeated, not as a refusal.
  const graph = graphs.buildRunGraph({ runId, events: log });
  const dup = graph.nodes.find((n) => n.eventId === absorbedEvent.eventId);
  assert.equal(dup.outcome, "noop");
  assert.equal(dup.label, "idea (duplicate)");
  assert.ok(graph.edges.some((edge) => edge.from === dup.id && edge.to === `I${added.id}` && edge.label === "duplicate"));
  const again = graph.nodes.find((n) => n.action === "confirm-solved" && n.lane === "member-3");
  assert.ok(graph.edges.some((edge) => edge.from === again.id && edge.label === "confirms (redundant)"));
  assert.deepEqual(finalize.supersededCitations(`Uses F${f1.id} and F${f2.id}`, findings.listFindingsForRun(hordeDir, runId)), [`F${f1.id} (now F${f2.id})`]);

  // Finalize: the answer is labeled, SUMMARY says the solve did not wind the run down, REPORT counts the repeats.
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CLEANUP = "off";
  const run = {
    id: runId, hordeDir, runDir, prompt: "issue 7 fixture", count: 3, cwd,
    members: [1, 2, 3].map((n) => Object.assign(newMemberState(n), { status: "done", endCause: "completed" })),
    startIdeaId: 0, startFactId: 0, startedAt: Date.now() - 60_000, stopped: false, cleanStopNames: [],
    controller: new AbortController(), controllers: new Map(), procs: new Map(), resets: [], solvedValidatedBy: "member-2", repairSkipped: ["member-3"],
  };
  await finalize.finalizeRun({ disposed: false, active: run, pi: { sendMessage: () => {} } }, run);
  const answer = fs.readFileSync(path.join(runDir, "ANSWER.md"), "utf8");
  assert.match(answer, new RegExp(`Status: peer-confirmed by member-2; acceptance incomplete;[^\\n]*cites superseded F${f1.id} \\(now F${f2.id}\\)`));
  const summary = fs.readFileSync(path.join(runDir, "SUMMARY.md"), "utf8");
  assert.match(summary, /member-1 proposed the goal solved at \d\d:\d\d:\d\d, validated by member-2; the run did not wind down on it\. Run ended when every member exited\. Repair: 0 attempt\(s\), 1 skipped for budget \(member-3\)\. Outcome: completed-incomplete\./);
  const reportMd = fs.readFileSync(path.join(runDir, "REPORT.md"), "utf8");
  assert.match(reportMd, /- outcome: completed-incomplete/);
  assert.match(reportMd, /- confirm-solved: 1 credited \(member-2\), 1 redundant \(member-3\)/);
  assert.match(reportMd, new RegExp(`- ideas: 1 created, 1 duplicate creation\\(s\\) absorbed \\(#${added.id} x1\\)`));
}

// ---- E. the end sentence from recorded facts; the schema names every action that needs text ---------
{
  const repaired = Object.assign(newMemberState(1), { repairs: 1, repairStopReason: "time" });
  const base = { id: "R", prompt: "p", count: 2, members: [repaired, newMemberState(2)], startedAt: 0, stopped: false };
  assert.equal(prompt.runEndSentence(base), "Run ended when every member exited. Repair: 1 attempt(s), 1 killed on budget (member-1: time).");
  assert.equal(
    prompt.runEndSentence({ ...base, members: [newMemberState(1)], stopped: true, stopLabel: "stopped at deadline", outcome: "stopped-clean" }),
    "Run stopped at deadline. Outcome: stopped-clean.",
  );
  const solved = { member: "member-2", text: "answer", at: "2026-10-18T02:44:48.759Z", revision: "r1" };
  assert.match(
    prompt.runEndSentence({ ...base, members: [newMemberState(1)], solved }),
    /^member-2 proposed the goal solved at \d\d:\d\d:\d\d, not validated by another member; the run did not wind down on it\. Run ended when every member exited\.$/,
  );
  assert.match(HordeParams.properties.text.description, /review \(the decision summary\)/);
}
console.log(`PASS: issue 7 regressions (${cwd})`);
