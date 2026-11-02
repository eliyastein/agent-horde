// Regressions for issue #37 (post-mortem of a run whose answer state outlived its withdrawal):
// A. a validated proposal withdrawn for an amended citation stops reporting the validation
// B. a proposal pins the artifacts it cites; a republish withdraws it like an amend
// C. date and placeholder path templates, and URL paths with hyphenated segments, are not
//    existence-checked as local files
// D. a repair round ends early when the only blocking work left is a served member's recheck
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
const signals = await jiti.import("../src/ledger/run-signals.ts");
const protocol = await jiti.import("../src/tool/collaboration-actions.ts");
const actions = await jiti.import("../src/tool/actions.ts");
const solved = await jiti.import("../src/run/solved.ts");
const repair = await jiti.import("../src/run/repair.ts");
const citations = await jiti.import("../src/citations.ts");
const { newMemberState } = await jiti.import("../src/member.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue37-"));
const hordeDir = files.initHordeDir(cwd);
let call = 0;
const command = async (runId, actor, params) =>
  JSON.parse((await protocol.runCollaborationAction({ hordeDir, runId, actor, attempt: "a1", requestId: `call-${++call}` }, params)).text);
const act = (runId, actor, params) => actions.runHordeAction(hordeDir, actor, params, runId, { attempt: "a1", requestId: `act-${++call}` });
const makeRun = async (runId) => {
  const runDir = path.join(hordeDir, "runs", runId);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 4\n");
  await board.appendRunHeading(hordeDir, runId, `issue 37 fixture ${runId}`);
  return runDir;
};
const fakeRun = (runId, runDir) => ({
  id: runId, hordeDir, runDir, prompt: "p", count: 4, cwd, members: [1, 2, 3, 4].map((n) => newMemberState(n)),
  startIdeaId: 0, startFactId: 0, startedAt: Date.now(), stopped: false, cleanStopNames: [],
  controller: new AbortController(), controllers: new Map(), procs: new Map(), resets: [],
});
const ctxStub = { ui: { notify: () => {} }, hasUI: false };
const answerStatus = (runDir) => /^Status: (.*)$/m.exec(fs.readFileSync(path.join(runDir, "ANSWER.md"), "utf8"))?.[1];
let concernN = 0;
const fileFinding = async (runId, author, text) =>
  (await findings.addFinding(hordeDir, runId, author, text, { concern: `concern-${++concernN}`, concernDef: `component ${concernN}`, concernNew: true })).finding;

// ---- A. validated, then withdrawn: ANSWER.md drops the validation --------------------------------
{
  const runId = "20261101-120001";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-2", "The campaign endpoint is agilekit.com\ndecoded from the archive");
  await act(runId, "member-1", { action: "solved", text: `The campaign reports to agilekit.com (F${f1.id})` });
  const run = fakeRun(runId, runDir);
  solved.checkSolved(run, ctxStub);
  await act(runId, "member-3", { action: "confirm-solved", text: "decoded it myself", revision: run.solved.revision });
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solvedValidatedBy, "member-3");
  assert.ok(!run.solvedCommitted, "unreviewed findings hold the commit while others run");
  assert.equal(answerStatus(runDir), "validated by member-3");

  await findings.amendFinding(hordeDir, runId, "member-2", { id: f1.id, text: "The campaign endpoint is agilekit.co\ndecoded from the archive, TLD corrected", note: "TLD misread" });
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solved, undefined, "the proposal citing the amended finding was withdrawn");
  assert.equal(run.solvedValidatedBy, undefined);
  const status = answerStatus(runDir);
  assert.equal(status, `withdrawn: it cites amended F${f1.id}; no validation carries over and no proposal is pending`);
  assert.doesNotMatch(status, /validated by/);
  assert.match(fs.readFileSync(path.join(runDir, "ANSWER.md"), "utf8"), /reports to agilekit\.com/, "the withdrawn text stays on record");

  // A fresh proposal replaces the withdrawn status.
  await act(runId, "member-1", { action: "solved", text: `The campaign reports to agilekit.co (F${f1.id})` });
  assert.equal(answerStatus(runDir), "proposed; awaiting validation");
}

// ---- B. artifact citations are pinned; a republish withdraws the proposal ------------------------
{
  const runId = "20261101-120002";
  const runDir = await makeRun(runId);
  const write = (body) => fs.writeFileSync(path.join(runDir, "artifacts/playbook.md"), body);
  write("# playbook\n\nprobe agilekit.com\n");
  const doc = (await command(runId, "member-1", { action: "artifact", artifactPath: "artifacts/playbook.md", artifactKind: "document", criteria: "accurate and sourced" })).artifact;
  await act(runId, "member-1", { action: "solved", text: `Use the playbook ${doc.id}` });
  assert.deepEqual(signals.readSolved(runDir).cites, { [doc.id]: doc.hash }, "the proposal pins the artifact revision");
  const run = fakeRun(runId, runDir);
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solved?.member, "member-1", "an unchanged artifact keeps the proposal");

  write("# playbook\n\nprobe agilekit.co\n");
  const next = (await command(runId, "member-1", { action: "artifact", target: doc.id, revision: doc.hash, artifactPath: "artifacts/playbook.md", artifactKind: "document", criteria: "accurate and sourced" })).artifact;
  assert.equal(next.id, doc.id);
  assert.notEqual(next.hash, doc.hash);
  await assert.rejects(act(runId, "member-2", { action: "confirm-solved", text: "agreed" }), new RegExp(`the pending answer cites republished ${doc.id}; it cannot be validated until member-1 re-proposes`));
  solved.checkSolved(run, ctxStub);
  assert.equal(run.solved, undefined, "the proposal citing the republished artifact was withdrawn");
  assert.match(answerStatus(runDir), new RegExp(`^withdrawn: it cites republished ${doc.id}`));
  assert.match(fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf8"), new RegExp(`SOLVED proposal by member-1 withdrawn: it cites republished ${doc.id}`));

  assert.deepEqual(findings.staleAnswerCitations([], `see ${doc.id}`, { [doc.id]: next.hash }, [next]), [], "the current revision is not stale");
  assert.deepEqual(findings.staleAnswerCitations([], `see ${doc.id}`, { A999: "x" }, [next]), [], "an unknown pinned artifact is ignored");
}

// ---- C. path templates and hyphenated URL paths are not local files -----------------------------
{
  const refs = citations.citedDataFiles(
    "Probe `/logs/client-gate-YYYY-MM-DD.jsonl` and /standalone-client-gate/logs/client-gate-YYYY-MM-DD.jsonl; " +
      "logs land in `logs/method2-gate-YYYY-MM-DD.jsonl`, `out/<id>.json` and `trace-%Y%m%d.log`; " +
      "probe /standalone-gate/data/export.json too. Local outputs: `artifacts/report.json` and lab-notes/run-a/summary.json.",
  );
  for (const template of ["client-gate/logs/client-gate-YYYY-MM-DD.jsonl", "logs/method2-gate-YYYY-MM-DD.jsonl", "out/<id>.json", "trace-%Y%m%d.log"]) {
    assert.ok(!refs.includes(template), `template "${template}" must not be checked`);
  }
  assert.ok(!refs.some((ref) => ref.includes("gate/data/export.json")), "a URL path is not cut at a hyphen into a local path");
  assert.ok(refs.includes("artifacts/report.json"), "a literal local path is still checked");
  assert.ok(refs.includes("lab-notes/run-a/summary.json"), "a hyphenated relative path is checked whole");
  assert.ok(!refs.includes("notes/run-a/summary.json"), "and not from inside its first segment");
}

// ---- D. a round ends early for a blocking recheck owed by a served member -----------------------
{
  const msg = (id, extra = {}) => ({ id, target: "F1", kind: "review-request", state: "open", createdAt: `2026-11-01T00:00:0${id.length}Z`, ...extra });
  const entry = (name, queue) => ({ member: { name }, queue });
  const handedAs = (pairs) => new Map(pairs.map(([name, threads]) => [name, new Map(threads)]));
  // member-7 was handed its review queue, raised Q423 during the attempt, and the owner answered it.
  const blockingRecheck = entry("member-7", [msg("Q423", { kind: "challenge", blocking: true, state: "responded" })]);
  const routine = entry("member-8", [msg("Q263")]);
  const served7 = handedAs([["member-7", [["Q217", "open::"]]]]);
  assert.equal(repair.blockedOnServed([blockingRecheck, routine], served7), true, "the served member's new recheck is the only blocking work");
  assert.equal(repair.blockedOnServed([blockingRecheck, routine], new Map()), false, "the round has not served the blocked member yet");
  const unservedBlocker = entry("member-1", [msg("Q426", { target: "answer", kind: "blocker", blocking: true })]);
  assert.equal(repair.blockedOnServed([blockingRecheck, unservedBlocker, routine], served7), false, "an unserved member's blocker is served first");
  assert.equal(repair.blockedOnServed([routine], handedAs([["member-8", []]])), false, "no blocking work, no early end");
  assert.equal(repair.blockedOnServed([], new Map()), false);
  // A blocker the member was handed and left as it was is no reason to serve it again early.
  const ignored = entry("member-2", [msg("Q9", { kind: "blocker", blocking: true })]);
  assert.equal(repair.blockedOnServed([ignored, routine], handedAs([["member-2", [["Q9", "open::"]]]])), false);
  assert.equal(repair.blockedOnServed([ignored, routine], handedAs([["member-2", [["Q9", "acked::"]]]])), true, "the same blocker moved since it was handed");
}

// ---- E. finalize names a citation amended after a committed answer pinned it --------------------
{
  const finalize = await jiti.import("../src/run/finalize.ts");
  const runId = "20261101-120005";
  const runDir = await makeRun(runId);
  const f1 = await fileFinding(runId, "member-2", "The gate logs to a dated JSONL file\nread from the source");
  await act(runId, "member-1", { action: "solved", text: `Probe the dated log (F${f1.id})` });
  await act(runId, "member-3", { action: "confirm-solved", text: "read the source too" });
  // A committed answer is no longer withdrawn; the amend lands during the clean-stop grace.
  await findings.amendFinding(hordeDir, runId, "member-2", { id: f1.id, text: "The gate logs to a dated JSONL file\nonly when log_dir is web-reachable", note: "scope" });
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CLEANUP = "off";
  const run = { ...fakeRun(runId, runDir), solved: signals.readSolved(runDir), solvedValidatedBy: "member-3", solvedCommitted: true,
    members: [1, 2, 3, 4].map((n) => Object.assign(newMemberState(n), { status: "done", endCause: "completed" })) };
  const swarm = { id: runId, dir: undefined, hordeDir, cwd, prompt: run.prompt, hordes: 1, count: 4, startedAt: run.startedAt, runs: [run] };
  await finalize.finalizeRun({ disposed: false, active: swarm, pi: { sendMessage: () => {} } }, swarm, run);
  assert.match(answerStatus(runDir), new RegExp(`^peer-confirmed by member-3;[^\\n]*cites amended F${f1.id};`));
}

console.log("issue 37 regressions passed");
