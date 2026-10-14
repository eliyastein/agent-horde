// Offline regressions from a document-acceptance run. Historical runs remain read-only.
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
const { claimResource, listResources } = await jiti.import("../src/ledger/resources.ts");
const { runCollaborationAction } = await jiti.import("../src/tool/collaboration-actions.ts");
const { collaborationState, artifactAccepted } = await jiti.import("../src/ledger/collaboration.ts");
const { loadCollaborationReport, freezeAcceptance } = await jiti.import("../src/collaboration-report.ts");
const { finalizeRun } = await jiti.import("../src/run/finalize.ts");
const { buildDiagnosis } = await jiti.import("../src/run/diagnosis.ts");
const { markSolved, confirmSolved } = await jiti.import("../src/ledger/run-signals.ts");
const { newMemberState } = await jiti.import("../src/member.ts");
const { readEvents } = await jiti.import("../src/ledger/events.ts");
fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-anthropic-"));
const hordeDir = initHordeDir(cwd);
const runId = "20260928-204030";
const runDir = path.join(hordeDir, "runs", runId);
fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 3\n");

// Generic checkout words must not alias unrelated targets or overwrite historical R8.
fs.appendFileSync(path.join(hordeDir, "RESOURCES.md"), "\n- [R8] sandbox-runtime pinned source checkout  @member-3: original sandbox checkout, old evidence remains authoritative\n");
const original = listResources(hordeDir)[0];
const cli = await claimResource(hordeDir, "member-3", { name: "anthropic-cli-pinned-source", note: "cli checkout pinned 488fa294c532a9bf6066bded8d49c7e9d7b3d52c", runId });
assert.equal(cli.reused, false);
assert.notEqual(cli.resource.id, 8);
assert.deepEqual(listResources(hordeDir).find((r) => r.id === 8), original);
const beforeAlias = cli.resource.note;
const alias = await claimResource(hordeDir, "member-3", { name: "anthropic-cli source checkout", note: "an alias must not change metadata", runId });
assert.equal(alias.resource.id, cli.resource.id);
assert.equal(alias.ownedByCaller, false);
assert.equal(alias.resource.note, beforeAlias);
const nextRun = await claimResource(hordeDir, "member-3", { name: cli.resource.name, note: "same member number in a different run", runId: "next-run" });
assert.equal(nextRun.resource.note, beforeAlias);
assert.equal(nextRun.ownedByCaller, false);
const update = await claimResource(hordeDir, "member-3", { name: cli.resource.name, note: "updated authoritative checkout note", runId });
assert.equal(update.ownedByCaller, true);
const history = fs.readFileSync(path.join(hordeDir, "resource-history.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
assert.equal(history.at(-1).previous.note, beforeAlias);
assert.equal(history.at(-1).replacement.note, update.resource.note);
assert.equal(history.at(-1).runId, runId);
const commonSite = "https://github.com/example-org";
await claimResource(hordeDir, "member-1", { name: "alpha repository", note: commonSite, runId });
assert.equal((await claimResource(hordeDir, "member-2", { name: "beta repository", note: commonSite, runId })).reused, false);

const command = async (actor, params) => JSON.parse((await runCollaborationAction({ hordeDir, runId, actor }, params)).text);
const publish = async (file, artifactKind, criteria = "claims match citations and disclose execution limits") => {
  fs.writeFileSync(path.join(runDir, "artifacts", file), "Assessment: local source checks only; live reachability unchecked.\n");
  return (await command("member-1", { action: "artifact", artifactPath: `artifacts/${file}`, artifactKind, criteria })).artifact;
};
const review = (a, support, unchecked = "", actor = "member-2", verdict = "supports") => command(actor, {
  action: "review", target: a.id, revision: a.hash, support, unchecked, verdict,
  checked: "entire stated artifact criteria", evidenceText: "independent fixture inspection and citation comparison", text: "criteria checked",
});
const accepted = (a) => artifactAccepted(collaborationState(hordeDir, runId), a);
const doc = await publish("assessment.md", "document");
await review(doc, "tested", "citation coverage incomplete");
assert.equal(accepted(doc), false, "execution support with limits is still partial");
await review(doc, "derived");
assert.equal(accepted(doc), true, "full independent derived review accepts an assessment document");
await assert.rejects(review(doc, "sourced", "", "member-1"), /independent review/);
const report = loadCollaborationReport(hordeDir, runId);
assert.deepEqual(report.acceptedDocuments, [doc.id]);
assert.deepEqual(report.acceptedRunnableArtifacts, []);
assert.ok(!report.issues.some((s) => s.startsWith(doc.id)));

const code = await publish("scanner.sh", undefined, "positive and negative execution controls");
assert.equal(code.kind, "runnable", "omission retains the strict default");
await review(code, "derived");
assert.equal(accepted(code), false, "document rules must not leak into runnable acceptance");
await review(code, "tested");
assert.equal(accepted(code), true);
assert.deepEqual(loadCollaborationReport(hordeDir, runId).acceptedRunnableArtifacts, [code.id]);
await assert.rejects(command("member-1", { action: "artifact", target: code.id, revision: code.hash, artifactPath: code.path, artifactKind: "document", criteria: code.criteria }), /kind is immutable/);
await assert.rejects(command("member-1", { action: "artifact", artifactPath: code.path, artifactKind: "document", criteria: code.criteria }), /document extension/);
await assert.rejects(command("member-1", { action: "artifact", target: doc.id, revision: doc.hash, artifactPath: doc.path, artifactKind: "document", criteria: "new broader contract" }), /new file revision/);
const legacy = { ...code };
delete legacy.kind;
const legacyState = { ...collaborationState(hordeDir, runId), reviews: [{ ...collaborationState(hordeDir, runId).reviews.at(-1), support: "derived" }] };
assert.equal(artifactAccepted(legacyState, legacy), false, "historical untyped artifacts retain the execution requirement");

// File changes, a new revision, partial checks, and blockers still prevent document acceptance.
fs.appendFileSync(path.join(runDir, doc.path), "Revised wording.\n");
assert.ok(loadCollaborationReport(hordeDir, runId).issues.some((s) => s.includes("file changed")));
const revised = (await command("member-1", { action: "artifact", target: doc.id, revision: doc.hash, artifactPath: doc.path, criteria: doc.criteria })).artifact;
assert.equal(revised.kind, "document");
assert.equal(accepted(revised), false, "old review cannot transfer to new document bytes");
await review(revised, "sourced");
assert.equal(accepted(revised), true);
await command("member-3", { action: "message", target: doc.id, kind: "challenge", text: "remaining citation disagreement" });
assert.equal(accepted(revised), false, "blocking challenges override full document review");
assert.equal(freezeAcceptance(hordeDir, runId).status, "incomplete");

// Finalization must retain who confirmed even though the acceptance gate fails.
const proposal = (await markSolved(hordeDir, runId, "member-3", "No reportable vulnerability established; limits retained.")).signal;
await confirmSolved(hordeDir, runId, "member-1", "I confirm the scoped conclusion", proposal.revision);
const members = [1, 2, 3].map((n) => Object.assign(newMemberState(n), { status: "done", endCause: "completed" }));
const run = { id: runId, runDir, hordeDir, cwd, count: 3, prompt: "offline acceptance fixture", members, stopped: false,
  startedAt: Date.now(), startIdeaId: 0, startFactId: 0, cleanStopNames: [], canary: "ok", controller: new AbortController(), controllers: new Map(), procs: new Map(), resets: [] };
const notices = [];
const state = { disposed: false, pi: { sendMessage: (m) => notices.push(m) }, active: run };
const saved = { ...process.env };
try {
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CLEANUP = "off";
  await finalizeRun(state, run);
} finally {
  for (const key of ["PI_HORDE_POSTMORTEM", "PI_HORDE_DELIVERABLE", "PI_HORDE_CLEANUP"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
}
assert.equal(run.solvedValidatedBy, "member-1");
assert.equal(run.acceptance, "incomplete");
assert.equal(notices.length, 1);
assert.match(run.diagnosis, /answer proposed by member-3, peer-confirmed by member-1, acceptance incomplete/);
const budgetDiagnosis = buildDiagnosis({ ...run, stopLabel: "solved", members: [{ ...members[0], endCause: "killed", repairStopReason: "tokens" }] }, { findings: [], distinctFindings: 0, claims: [], released: [], latePosts: [] });
assert.match(budgetDiagnosis, /abnormal ends: member-1 killed \(repair tokens\)/);
assert.doesNotMatch(budgetDiagnosis, /solved: member-1/);
const answer = fs.readFileSync(path.join(runDir, "ANSWER.md"), "utf8");
const finalReport = fs.readFileSync(path.join(runDir, "REPORT.md"), "utf8");
assert.match(answer, /peer-confirmed by member-1; acceptance incomplete/);
assert.match(answer, /open blocking at freeze: Q\d+ \S+ \w+ blocking challenge/, "the answer names blockers still open at freeze");
assert.doesNotMatch(answer, /DELIVERABLE\.md/, "no pointer when no deliverable was written");
assert.match(finalReport, /peer-confirmed by member-1; acceptance incomplete/);
assert.match(finalReport, /outcome: completed-incomplete/);
assert.doesNotMatch(finalReport, /no other member confirmed/);
assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "answers", `${proposal.revision}.json`), "utf8")).confirm.member, "member-1");
assert.ok(readEvents(hordeDir, runId).some((e) => e.outcome === "rejected"), "refused contract changes remain auditable");
console.log(`PASS: resource integrity, document acceptance and confirmation attribution (${cwd})`);
