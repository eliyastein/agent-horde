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
const { compactReceipt, collaborationView } = await jiti.import("../src/tool/collaboration-view.ts");
const { initHordeDir } = await jiti.import("../src/ledger/files.ts");
const { appendRunHeading } = await jiti.import("../src/ledger/board.ts");
const { addFinding } = await jiti.import("../src/ledger/findings.ts");
const { runCollaborationAction } = await jiti.import("../src/tool/collaboration-actions.ts");
const { collaborationState, artifactAccepted } = await jiti.import("../src/ledger/collaboration.ts");
const { readEvents } = await jiti.import("../src/ledger/events.ts");
fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-token-"));
const hordeDir = initHordeDir(cwd);
const runId = "token-test";
const runDir = path.join(hordeDir, "runs", runId);
fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 3\n");
await appendRunHeading(hordeDir, runId, "token fixture");
const ctx = (actor) => ({ hordeDir, runId, actor, attempt: "fixture" });
const command = async (actor, params) => JSON.parse((await runCollaborationAction(ctx(actor), params)).text);
const long = "full retained observation and method ".repeat(500);
const f = (await addFinding(hordeDir, runId, "member-1", long, {})).finding;
const target = `F${f.id}`;
const info = await command("member-2", { action: "inspect", target });
assert.ok(!JSON.stringify(info).includes(long), "revision lookup stays small");
assert.equal((await command("member-2", { action: "inspect", target, detail: "full" })).finding.body.trim(), long.trim());
const params = { action: "review", target, revision: info.revision, verdict: "supports", support: "tested", checked: long, unchecked: "live integration is untested", evidenceText: long, text: long, refs: [], requestId: "combined" };
const before = JSON.stringify(params);
const result = await command("member-2", params);
assert.equal(JSON.stringify(params), before, "combined review does not mutate retry input");
assert.equal((await command("member-2", params)).eventId, result.eventId);
assert.equal(readEvents(hordeDir, runId).filter((e) => e.action === "review").length, 1);
const state = collaborationState(hordeDir, runId);
assert.equal(state.evidence[0].text, long.trim());
assert.deepEqual(state.reviews[0].evidence, [state.evidence[0].id]);
assert.equal(state.reviews[0].unchecked, params.unchecked);
assert.ok(!readEvents(hordeDir, runId).at(-1).parents.includes(result.eventId), "combined event has no self-parent");
const serialized = JSON.stringify(result);
const receipt = compactReceipt(serialized, params);
assert.ok(receipt.length < serialized.length / 10, "write receipt avoids echoing long authored prose");
assert.equal(JSON.parse(receipt).review.unchecked, params.unchecked, "short limitations remain visible");
assert.equal(compactReceipt(serialized, { ...params, detail: "full" }), serialized);
assert.equal(compactReceipt("plain legacy result", params), "plain legacy result");
const event = await command("member-2", { action: "inspect", target: result.eventId });
assert.equal(event.event.payload.evidenceRecord.text, long.trim());
assert.equal(event.event.payload.review.checked, long.trim());
assert.equal((await command("member-2", { action: "inspect", target: result.review.id })).review.text, long.trim());

// Rejection remains atomic and retains the entire rejected input.
await assert.rejects(command("member-1", { ...params, requestId: "self" }), /independent review/);
await assert.rejects(command("member-3", { ...params, requestId: "stale", revision: "old" }), /current revision/);
assert.equal(collaborationState(hordeDir, runId).evidence.length, 1);
assert.equal(readEvents(hordeDir, runId).at(-1).payload.input.evidenceText, long);

// An atomic failed review still opens a blocker; only independently tested full coverage accepts code.
fs.writeFileSync(path.join(runDir, "artifacts/code.txt"), "fixture bytes");
const artifact = (await command("member-1", { action: "artifact", artifactPath: "artifacts/code.txt", criteria: "two controls" })).artifact;
await command("member-2", { ...params, target: artifact.id, revision: artifact.hash, verdict: "refutes", artifactPath: "artifacts/code.txt", requestId: "failed-code" });
const failed = collaborationState(hordeDir, runId);
assert.equal(failed.messages.filter((m) => m.target === artifact.id && m.blocking).length, 1);
assert.ok(failed.evidence.at(-1).hash);
assert.equal(artifactAccepted(failed, artifact), false);
const cleanArtifact = (await command("member-1", { action: "artifact", artifactPath: "artifacts/code.txt", criteria: "both controls" })).artifact;
await command("member-3", { ...params, target: cleanArtifact.id, revision: cleanArtifact.hash, unchecked: "", requestId: "fully-tested" });
assert.equal(artifactAccepted(collaborationState(hordeDir, runId), cleanArtifact), true, "atomic full independent review can accept code");

// Paging is lossless; previews mark shortened fields and expose all IDs/limitations/next cursors.
const many = { ...state, evidence: Array.from({ length: 61 }, (_, i) => ({ ...state.evidence[0], id: `E${100 + i}`, target: i % 2 ? "F2" : target })) };
const snapshot = JSON.stringify(many);
const page = collaborationView(many, { action: "collaboration" });
assert.equal(page.evidence.length, 25);
assert.equal(page.counts.evidence, 61);
assert.equal(page.next.evidence, 25);
assert.equal(page.evidence[0].fullFieldChars.text, long.trim().length);
assert.equal(page.reviews[0].unchecked, params.unchecked);
const recovered = [];
for (let offset = 0; offset < 61; offset += 25) recovered.push(...collaborationView(many, { action: "collaboration", detail: "full", offset }).evidence);
assert.deepEqual(recovered, many.evidence);
assert.equal(JSON.stringify(many), snapshot, "views never mutate authoritative state");
assert.equal(collaborationView(many, { action: "collaboration", target: "F2" }).counts.evidence, 30);
assert.ok(JSON.stringify(page).length < snapshot.length / 10);
// The registered model-facing tool uses compact receipts; explicit reads return the full evidence.
const { registerMemberTool } = await jiti.import("../src/tool/register.ts");
process.env.PI_HORDE_DIR = hordeDir;
process.env.PI_HORDE_RUN = runId;
process.env.PI_HORDE_NAME = "member-3";
let tool;
registerMemberTool({ registerTool: (value) => { tool = value; }, on: () => {} });
const written = await tool.execute("model-write", { action: "attach", target, text: long });
const compact = JSON.parse(written.content[0].text);
assert.equal(compact.evidenceRecord.text.stored, true);
const fetched = await tool.execute("model-read", { action: "inspect", target: compact.eventId });
assert.equal(JSON.parse(fetched.content[0].text).event.payload.evidenceRecord.text, long.trim());
console.log(`PASS: horde-token-test; long-write receipt ${serialized.length} -> ${receipt.length} characters, full evidence retained (${cwd})`);
