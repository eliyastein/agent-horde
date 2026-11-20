// Regressions for issue #47 (post-mortem of a run that proposed one unchanged answer four times):
// A. a proposal is refused validation and withdrawn while a finding filed after it goes unnamed,
//    and re-proposing the same text does not move the mark past that finding
// B. a contest reopens the proposal only on ideas that were open when it was made
// C. the same text, contested twice with no idea to wait on, is refused a third time
// D. a confirmation carries to a reopened proposal with the same text and citations
// E. a member that closes with blocking requests unanswered is reset once for them
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
const signals = await jiti.import("../src/ledger/run-signals.ts");
const protocol = await jiti.import("../src/tool/collaboration-actions.ts");
const actions = await jiti.import("../src/tool/actions.ts");
const solved = await jiti.import("../src/run/solved.ts");
const supervise = await jiti.import("../src/run/supervise.ts");
const { newMemberState } = await jiti.import("../src/member.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue47-"));
const hordeDir = files.initHordeDir(cwd);
let call = 0;
const command = async (runId, actor, params) =>
  JSON.parse((await protocol.runCollaborationAction({ hordeDir, runId, actor, attempt: "a1", requestId: `call-${++call}` }, params)).text);
const act = (runId, actor, params) => actions.runHordeAction(hordeDir, actor, params, runId, { attempt: "a1", requestId: `act-${++call}` });
const makeRun = async (runId) => {
  const runDir = path.join(hordeDir, "runs", runId);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 4\n");
  await board.appendRunHeading(hordeDir, runId, `issue 47 fixture ${runId}`);
  return runDir;
};
const fakeRun = (runId, runDir) => ({
  id: runId, hordeDir, runDir, prompt: "p", count: 4, cwd, members: [1, 2, 3, 4].map((n) => newMemberState(n)),
  startIdeaId: 0, startFactId: 0, startedAt: Date.now(), stopped: false, cleanStopNames: [],
  controller: new AbortController(), controllers: new Map(), procs: new Map(), resets: [],
});
const ctxStub = { ui: { notify: () => {} }, hasUI: false };
const answerStatus = (runDir) => /^Status: (.*)$/m.exec(fs.readFileSync(path.join(runDir, "ANSWER.md"), "utf8"))?.[1];
const boardText = () => fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf8");
let concernN = 0;
const fileFinding = async (runId, author, text) =>
  (await findings.addFinding(hordeDir, runId, author, text, { concern: `concern-${++concernN}`, concernDef: `component ${concernN}`, concernNew: true })).finding;
const openIdea = async (owner, text) => {
  const { idea } = await ideas.addIdea(hordeDir, owner, text);
  await ideas.claimIdea(hordeDir, owner, idea.id, { checkOverlap: false });
  return idea;
};

// ---- A. a finding filed after the proposal must be named ------------------------------------------
{
  const runId = "20261119-120001";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-2", "The router trusts the forwarded host header\nread from the source");
  const f2 = await fileFinding(runId, "member-3", "The retry middleware replays request bodies\nread from the source");
  const text = `Two candidates survived: F${f1.id} and F${f2.id}`;
  await act(runId, "member-1", { action: "solved", text });
  assert.equal(signals.readSolved(runDir).findingsMark, f2.id, "the proposal records the run's highest F#");
  const run = fakeRun(runId, runDir);
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solved?.member, "member-1");

  const f3 = await fileFinding(runId, "member-4", "The allow-list verdict ignores the deny rule\nread from the source");
  const omits = `omits F${f3.id}, filed after the answer was first proposed`;
  await assert.rejects(act(runId, "member-2", { action: "confirm-solved", text: "agreed" }), new RegExp(`the pending answer ${omits}`));
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solved, undefined, "the proposal that omits the later finding was withdrawn");
  assert.match(answerStatus(runDir), new RegExp(`^withdrawn: it ${omits}`));
  assert.match(boardText(), new RegExp(`SOLVED proposal by member-1 withdrawn: it ${omits}`));

  // The same text proposed again inherits the first proposal's mark, so the omission still shows.
  await assert.rejects(act(runId, "member-1", { action: "solved", text }), new RegExp(`the answer ${omits}`));
  await act(runId, "member-2", { action: "solved", text: `${text}. F${f3.id} is excluded: the deny rule is unreachable in this build` });
  assert.equal(signals.readSolved(runDir).findingsMark, f2.id, "a later proposal keeps the first mark");
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solved?.member, "member-2", "naming the finding, even to exclude it, satisfies the gate");

  // A finding that supersedes a cited one is reported once, as the stale citation.
  const f4 = (await findings.addFinding(hordeDir, runId, "member-3", "The retry middleware replays bodies only under 1 MiB\nmeasured", { supersedes: f2.id })).finding;
  const all = findings.listFindingsForRun(hordeDir, runId);
  assert.deepEqual(findings.omittedFindings(all, run.solved.text, f2.id), []);
  assert.deepEqual(findings.omittedFindings(all, "nothing named", f2.id), [`F${f3.id}`, `F${f4.id}`]);
  assert.deepEqual(findings.omittedFindings(all, "nothing named", undefined), [], "a proposal without a mark is not checked");
  assert.equal(findings.answerObjection([], []), undefined);
}

// ---- B. only ideas open at the contest reopen the proposal ---------------------------------------
{
  const runId = "20261119-120002";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-2", "The dashboard exposes the admin API without auth\nread from the source");
  const closed = await openIdea("member-3", "audit the ingress annotation parser for header smuggling");
  await ideas.ruleOutIdea(hordeDir, "member-3", closed.id, "the parser rejects folded headers");
  await act(runId, "member-1", { action: "solved", text: `One candidate survived: F${f1.id}` });
  const run = fakeRun(runId, runDir);
  solved.checkSolved(run, ctxStub);
  const contest = await act(runId, "member-4", { action: "contest-solved", text: `the coverage paragraph is stale; see #${closed.id}`, revision: run.solved.revision });
  assert.match(contest.text, /Your contest names no open idea, so the proposal does not reopen on its own/);
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solvedContested, true);
  assert.equal(run.solvedContest, undefined, "a closed idea is not a blocker to wait on");
  assert.match(boardText(), /The contest names no open idea, so nothing reopens this proposal: member-1 or any other member proposes a changed answer/);
  solved.checkSolved(run, ctxStub);
  solved.checkSolved(run, ctxStub);
  assert.equal(signals.readSolved(runDir), undefined, "the unchanged text is not put back before the members");
  const archived = signals.archivedSolved(runDir);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].blockers, undefined);
}

// ---- C. the same text, contested twice with nothing to wait on, is refused ------------------------
{
  const runId = "20261119-120003";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-2", "The plugin loader follows symlinks out of the plugin root\nread from the source");
  const text = `One candidate survived: F${f1.id}`;
  const run = fakeRun(runId, runDir);
  for (const round of [1, 2]) {
    await act(runId, "member-1", { action: "solved", text });
    solved.checkSolved(run, ctxStub);
    await act(runId, "member-3", { action: "contest-solved", text: `republish the summary with the affected versions (round ${round})`, revision: run.solved.revision });
    solved.checkSolved(run, ctxStub);
  }
  assert.equal(signals.unansweredContests(runDir, text).length, 2);
  assert.match(boardText(), /This exact answer has now been contested 2 times without an open idea to wait on; it is refused if proposed again unchanged/);
  await assert.rejects(act(runId, "member-1", { action: "solved", text }), /this exact answer was contested 2 times, last by member-3: republish the summary with the affected versions \(round 2\)/);
  await act(runId, "member-1", { action: "solved", text: `${text}, affecting 3.6 and 3.7` });
  assert.equal(signals.readSolved(runDir).member, "member-1", "a changed answer is accepted");
}

// ---- D. a confirmation carries to the same text and citations ------------------------------------
{
  const runId = "20261119-120004";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-2", "The TCP router matches SNI case-sensitively\nread from the source");
  const blocker = await openIdea("member-4", "check the UDP entry point for the same SNI comparison");
  const text = `One candidate survived: F${f1.id}`;
  await act(runId, "member-1", { action: "solved", text });
  const run = fakeRun(runId, runDir);
  solved.checkSolved(run, ctxStub);
  const first = run.solved.revision;
  await act(runId, "member-3", { action: "confirm-solved", text: "reproduced the mismatch", revision: first });
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solvedValidatedBy, "member-3");
  await act(runId, "member-2", { action: "contest-solved", text: `premature: #${blocker.id} is still open`, revision: first });
  solved.checkSolved(run, ctxStub);
  assert.deepEqual(run.solvedContest.blockers, [blocker.id]);
  assert.deepEqual(signals.archivedSolved(runDir)[0].blockers, [blocker.id]);
  assert.equal(signals.unansweredContests(runDir, text).length, 0, "a contest that waits on an open idea is answered by its closing");
  await ideas.ruleOutIdea(hordeDir, "member-4", blocker.id, "UDP has no SNI");
  solved.checkSolved(run, ctxStub);
  const reopened = signals.readSolvedState(runDir).proposal;
  assert.notEqual(reopened.revision, first, "the reopened proposal has a new revision");
  assert.equal(reopened.findingsMark, f1.id, "and keeps its findings mark");
  solved.checkSolved(run, ctxStub);
  const carried = signals.readSolvedState(runDir).confirm;
  assert.equal(carried.member, "member-3");
  assert.equal(carried.revision, reopened.revision);
  assert.match(answerStatus(runDir), new RegExp(`^validated by member-3 \\(confirmation of revision ${first.slice(0, 8)} carried over: text and citations unchanged\\)`));
  assert.match(boardText(), /Its text and citations are the ones member-3 already confirmed, so that confirmation carries over/);
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solvedValidatedBy, "member-3", "the carried confirmation validates the new revision");

  // A contest of the carried revision still wins, and a changed text earns no carried confirmation.
  await act(runId, "member-2", { action: "contest-solved", text: "the SNI comparison was fixed upstream", revision: reopened.revision });
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solved, undefined);
  await act(runId, "member-1", { action: "solved", text: `${text}, fixed upstream in 3.7.18` });
  solved.checkSolved(run, ctxStub);
  assert.equal(signals.readSolvedState(runDir).confirm, undefined, "a different text is validated afresh");
  assert.equal(run.solvedValidatedBy, undefined);

  // The validator's own re-proposal of the text it confirmed does not validate itself.
  await act(runId, "member-2", { action: "contest-solved", text: "version range is wrong", revision: run.solved.revision });
  solved.checkSolved(run, ctxStub);
  await act(runId, "member-3", { action: "solved", text });
  solved.checkSolved(run, ctxStub);
  assert.equal(signals.readSolvedState(runDir).confirm, undefined, "the proposer cannot carry its own confirmation");
}

// ---- E. blocking requests unanswered at close reset their recipient once -------------------------
{
  const runId = "20261119-120005";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "The summary lists two candidates\nwritten from the ledger");
  const run = fakeRun(runId, runDir);
  const [member1, member2] = run.members;
  for (const member of run.members) { member.status = "done"; member.endCause = "completed"; }
  assert.equal(supervise.blockingBacklog(run, member1), undefined, "no requests, no backlog");
  const { message } = await command(runId, "member-2", { action: "message", kind: "blocker", target: `F${f1.id}`, text: "add the third candidate before this ships" });
  await command(runId, "member-2", { action: "message", kind: "question", target: `F${f1.id}`, text: "which build did you read?" });
  assert.equal(supervise.blockingBacklog(run, member1), `blocking backlog: ${message.id} unanswered at close`, "only the blocking request is owed");
  assert.equal(supervise.blockingBacklog(run, member2), undefined, "the sender owes nothing");
  member1.endCause = "killed";
  assert.equal(supervise.blockingBacklog(run, member1), undefined, "an abnormal end is handled by the crash reset");
  member1.endCause = "completed";
  run.backlogServed = [`member-1:${message.id}`];
  assert.equal(supervise.blockingBacklog(run, member1), undefined, "a request resets its recipient once");
  run.backlogServed = [];
  const revision = findings.findingRevision(findings.listFindingsForRun(hordeDir, runId)[0]);
  await command(runId, "member-1", { action: "respond", target: message.id, text: "the third candidate is out of scope", revision });
  assert.equal(supervise.blockingBacklog(run, member1), undefined, "a response hands the thread back to its sender");
}

console.log("issue 47 regressions passed");
