import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJiti, DEPS, PI } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  "@earendil-works/pi-coding-agent": PI,
  "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
  "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
  typebox: `${DEPS}/typebox/build/index.mjs`,
} });
const events = await jiti.import("../src/ledger/events.ts");
if (process.argv.includes("--event-writer")) {
  for (let n = 0; n < 10; n++) await events.recordEvent({ hordeDir: process.argv[3], runId: "parallel", actor: `worker-${process.pid}` }, "probe", { payload: { n } });
  process.exit(0);
}
const files = await jiti.import("../src/ledger/files.ts");
const board = await jiti.import("../src/ledger/board.ts");
const ideas = await jiti.import("../src/ledger/ideas.ts");
const findings = await jiti.import("../src/ledger/findings.ts");
const signals = await jiti.import("../src/ledger/run-signals.ts");
const protocol = await jiti.import("../src/tool/collaboration-actions.ts");
const collab = await jiti.import("../src/ledger/collaboration.ts");
const resources = await jiti.import("../src/ledger/resources.ts");
const report = await jiti.import("../src/collaboration-report.ts");
const inbox = await jiti.import("../src/tool/inbox.ts");
const dashboard = await jiti.import("../src/dashboard.ts");
const finalize = await jiti.import("../src/run/finalize.ts");
const { newMemberState } = await jiti.import("../src/member.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-collaboration-"));
const hordeDir = files.initHordeDir(cwd);
const runId = "20260925-191813";
const runDir = path.join(hordeDir, "runs", runId);
fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 3\nVerifier: member-3\n");
await board.appendRunHeading(hordeDir, runId, "local scanner repair");
let call = 0;
const context = (actor, attempt = "a1") => ({ hordeDir, runId, actor, attempt });
const command = async (actor, params, attempt = "a1") => JSON.parse((await protocol.runCollaborationAction({ ...context(actor, attempt), requestId: `call-${++call}` }, params)).text);
const inspect = (actor, target) => command(actor, { action: "inspect", target });

// Durable IDs, retries and full rejected submissions.
const i = (await ideas.addIdea(hordeDir, "member-1", "scanner implementation with positive and negative controls")).idea;
await ideas.claimIdea(hordeDir, "member-1", i.id);
const retry = { action: "message", target: `I${i.id}`, text: "status?", requestId: "stable" };
const first = await command("member-2", retry);
const again = await command("member-2", retry);
assert.equal(first.eventId, again.eventId);
await assert.rejects(command("member-2", { ...retry, text: "different command" }), /request id reused/);
const long = "retained evidence ".repeat(1000);
await assert.rejects(command("member-2", { action: "attach", target: "F999", text: long }), /unknown target/);
assert.equal(events.readEvents(hordeDir, runId).at(-1).payload.input.text, long);

// Rejections name the missing field and the id kind; the IDEAS.md `#n` form reaches the idea.
await assert.rejects(command("member-2", { action: "message", text: "no target" }), /target is required for action 'message'/);
await assert.rejects(command("member-2", { action: "message", target: `I${i.id}`, text: "see V7", refs: ["V7"] }), /unknown evidence V7; V7 is not evidence, refs take E# ids/);
for (const form of [`#${i.id}`, `I#${i.id}`]) {
  const sent = await command("member-2", { action: "message", target: form, text: `status via ${form}?` });
  assert.equal(sent.message.target, `I${i.id}`, `${form} addresses idea I${i.id}`);
}

// Multi-process serialization and torn-tail recovery, with no invented committed records.
await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--event-writer", hordeDir], { stdio: "pipe" });
  let stderr = ""; child.stderr.on("data", (b) => stderr += b);
  child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
})));
assert.equal(events.readEvents(hordeDir, "parallel").length, 30);
const eventFile = events.eventPath(hordeDir, "parallel");
fs.appendFileSync(eventFile, '{"torn":');
assert.equal(events.readEvents(hordeDir, "parallel").length, 30);
await events.recordEvent({ hordeDir, runId: "parallel", actor: "parent" }, "after-crash", { payload: {} });
assert.equal(events.readEvents(hordeDir, "parallel").length, 31);
assert.ok(fs.readdirSync(path.dirname(eventFile)).some((name) => name.includes(".torn-")));

// Scanner false-positive defect: reviewer discovers a false positive after the owner has finished.
const scanner = path.join(runDir, "artifacts/scanner.cjs");
fs.writeFileSync(scanner, "console.log(process.argv[2] !== '404' ? 'tracker' : 'unknown');\n");
const artifact = (await command("member-1", { action: "artifact", artifactPath: "artifacts/scanner.cjs", criteria: "403 must be unknown; marker must be tracker" })).artifact;
const runScanner = (value) => spawnSync(process.execPath, [scanner, value], { encoding: "utf8" }).stdout.trim();
assert.equal(runScanner("403"), "tracker");
const badEvidence = (await command("member-3", { action: "attach", target: artifact.id, text: "403 fixture incorrectly returns tracker", relation: "contradicts" })).evidenceRecord;
let state = collab.collaborationState(hordeDir, runId);
const challenge = state.messages.find((m) => m.target === artifact.id);
assert.ok(challenge.blocking);
await command("member-3", { action: "review", target: artifact.id, revision: artifact.hash, verdict: "refutes", support: "tested", checked: "negative 403 control", unchecked: "positive control", text: "false positive", refs: [badEvidence.id] });
assert.ok(report.loadCollaborationReport(hordeDir, runId).issues.some((x) => x.includes(artifact.id)));
await assert.rejects(command("member-2", { action: "ack", target: challenge.id, text: "steal" }), /recipient/);
await command("member-1", { action: "ack", target: challenge.id, text: "repair predicate" });
fs.writeFileSync(scanner, "console.log(process.argv[2] === 'marker' ? 'tracker' : 'unknown');\n");
const revised = (await command("member-1", { action: "artifact", target: artifact.id, revision: artifact.hash, artifactPath: "artifacts/scanner.cjs", criteria: "403 unknown; marker tracker" })).artifact;
assert.notEqual(revised.hash, artifact.hash);
assert.equal(fs.readFileSync(path.join(runDir, artifact.snapshot), "utf8").includes("!== '404'"), true, "old bytes retained");
await command("member-1", { action: "respond", target: challenge.id, revision: revised.hash, text: "predicate repaired" });
await assert.rejects(command("member-3", { action: "review", target: revised.id, revision: artifact.hash, verdict: "supports", support: "tested", checked: "all", unchecked: "", refs: [badEvidence.id], text: "stale" }), /current revision/);
assert.equal(runScanner("403"), "unknown");
assert.equal(runScanner("marker"), "tracker");
const good = (await command("member-3", { action: "attach", target: revised.id, text: "403 unknown; marker tracker", relation: "supports" })).evidenceRecord;
await command("member-3", { action: "review", target: revised.id, revision: revised.hash, verdict: "supports", support: "tested", checked: "both positive and negative controls", unchecked: "", refs: [good.id], text: "both passed" });
await command("member-3", { action: "resolve", target: challenge.id, refs: [good.id], text: "independent retest passed" });
assert.deepEqual(report.loadCollaborationReport(hordeDir, runId).acceptedArtifacts, [artifact.id]);

// Exact-scope review and cross-owner evidence; source checks cannot accept a runnable artifact.
const f = (await findings.addFinding(hordeDir, runId, "member-1", "local layout AND a live site", { ideaId: i.id, support: "sourced" })).finding;
const fi = await inspect("member-2", `F${f.id}`);
const partial = (await command("member-2", { action: "attach", target: fi.target, text: "local layout exists" })).evidenceRecord;
await command("member-2", { action: "review", target: fi.target, revision: fi.revision, verdict: "partially-supports", support: "derived", checked: "local layout", unchecked: "live site", refs: [partial.id], text: "does not establish live deployment" });
assert.ok(report.freezeAcceptance(hordeDir, runId).issues.some((issue) => issue.includes(`F${f.id}`)));
await findings.verifyFinding(hordeDir, runId, "member-2", { id: f.id, support: "derived", text: long });
await findings.verifyFinding(hordeDir, runId, "member-3", { id: f.id, support: "tested", text: "second check retained" });
assert.ok(findings.listFindingsForRun(hordeDir, runId)[0].body.includes(long.trim()));
assert.ok(findings.listFindingsForRun(hordeDir, runId)[0].body.includes("second check retained"));
assert.equal((await inspect("member-2", fi.target)).revision, fi.revision, "review notes do not change the subject revision");

// Inbox insertion at turn boundaries works without horde-tool calls. Receipt follows persistence.
const handlers = new Map();
inbox.registerInbox({ on: (name, fn) => handlers.set(name, fn) }, context("member-1", "hook-attempt"));
const boundary = { outcome: "completed", context: { canContinue: true } };
const proposed = handlers.get("agent_before_settle")(boundary);
assert.ok(proposed.continue && proposed.entries.length);
assert.equal(Object.keys(collab.collaborationState(hordeDir, runId).messages[0].deliveries).length, 0);
const persisted = proposed.entries.map((entry, n) => ({ ...entry, id: `session-${n}` }));
await handlers.get("turn_start")({}, { sessionManager: { getBranch: () => persisted } });
assert.ok(Object.keys(collab.collaborationState(hordeDir, runId).messages[0].deliveries).length > 0);
handlers.get("session_compact")();
assert.ok(handlers.get("turn_end")(boundary), "unresolved obligations survive compaction");
assert.equal(handlers.get("turn_end")({ outcome: "aborted", context: { canContinue: true } }), undefined);

// Resource readiness, generations, safe takeover and port reservations.
const r1 = (await resources.claimResource(hordeDir, "member-1", { name: "primary-lab", runId })).resource;
const r2 = (await resources.claimResource(hordeDir, "member-2", { name: "different-corpus", runId })).resource;
const building = (await command("member-1", { action: "resource-state", target: `R${r1.id}`, resourceState: "building", text: "starting", ports: [8347], leaseSeconds: 1 })).contract;
await assert.rejects(command("member-2", { action: "resource-state", target: `R${r2.id}`, resourceState: "building", ports: [8347], text: "collision" }), /port reserved/);
await assert.rejects(command("member-1", { action: "resource-state", target: `R${r1.id}`, generation: building.generation, resourceState: "ready", text: "trust me" }), /health-check evidence/);
await assert.rejects(command("member-2", { action: "resource-state", target: `R${r1.id}`, generation: building.generation, resourceState: "broken", text: "take over" }), /leased by/);
await new Promise((resolve) => setTimeout(resolve, 1100));
const taken = (await command("member-2", { action: "resource-state", target: `R${r1.id}`, generation: building.generation, resourceState: "broken", ports: [8347], text: "inspected expired lab; unhealthy" }, "a2")).contract;
assert.equal(taken.owner, "member-2");
await assert.rejects(command("member-1", { action: "resource-state", target: `R${r1.id}`, generation: building.generation, resourceState: "building", text: "stale writer" }), /generation changed/);

// Findings mentioning unfinished work cannot complete it automatically.
const reconciled = await ideas.reconcileOwnedIdeas(hordeDir, runId, ["member-1"]);
assert.deepEqual(reconciled.closed, []);
assert.ok(reconciled.released.includes(i.id));

// Late contest after clean stop wins in the actual finalizer, and full reasons survive.
process.env.PI_HORDE_POSTMORTEM = "off";
process.env.PI_HORDE_DELIVERABLE = "off";
process.env.PI_HORDE_CLEANUP = "off";
await signals.markSolved(hordeDir, runId, "member-1", "claim requiring correction");
const answerInfo = await inspect("member-2", "answer");
assert.equal(answerInfo.owner, "member-1");
assert.equal(answerInfo.revision, signals.readSolvedState(runDir).proposal.revision);
assert.equal((await signals.confirmSolved(hordeDir, runId, "member-2", "stale check", "older-revision")).ok, false);
assert.equal((await signals.contestSolved(hordeDir, runId, "member-2", "stale contest", "older-revision")).ok, false);
await signals.confirmSolved(hordeDir, runId, "member-2", "initial check");
signals.writeCleanStop(runDir, { runId, members: [], at: new Date().toISOString() });
await signals.contestSolved(hordeDir, runId, "member-3", long);
const run = { id: runId, hordeDir, runDir, prompt: "test", count: 3, cwd,
  members: [1, 2, 3].map((n) => Object.assign(newMemberState(n), { status: "done", endCause: "completed" })),
  startIdeaId: 0, startFactId: 0, startedAt: Date.now(), stopped: true, userStop: true, cleanStopNames: ["member-1"],
  controller: new AbortController(), controllers: new Map(), procs: new Map(), resets: [], solvedValidatedBy: "member-2" };
await finalize.finalizeRun({ disposed: false, active: run, pi: { sendMessage: () => {} } }, run);
assert.equal(run.solvedValidatedBy, undefined);
assert.equal(run.solvedContested, true);
assert.match(fs.readFileSync(path.join(runDir, "ANSWER.md"), "utf8"), /Status: contested by member-3/);
assert.ok(fs.readFileSync(path.join(runDir, "ANSWER.md"), "utf8").includes(long.trim()));
assert.equal(fs.readdirSync(path.join(runDir, "answers")).length, 1);
assert.match(fs.readFileSync(path.join(runDir, "REPORT.md"), "utf8"), /outcome: solved-contested/);

// Escaped, read-only human audit and JSON twin; historical data is not invented.
const source = { hordeDir, getActive: () => undefined };
const web = dashboard.routeRequest(source, "GET", new URL(`http://127.0.0.1/runs/${runId}/collaboration`), "127.0.0.1");
assert.equal(web.status, 200);
assert.match(web.body, /Event audit/);
const api = dashboard.routeRequest(source, "GET", new URL(`http://127.0.0.1/api/runs/${runId}/collaboration`), "127.0.0.1");
assert.equal(JSON.parse(api.body).report.runId, runId);
assert.equal(dashboard.routeRequest(source, "POST", new URL(`http://127.0.0.1/runs/${runId}/collaboration`), "127.0.0.1").status, 405);
console.log(`PASS: horde-collaboration-test (fixtures retained in ${cwd})`);
