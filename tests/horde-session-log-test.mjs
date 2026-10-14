import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": PI,
    "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
    "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
    typebox: `${DEPS}/typebox/build/index.mjs`,
  },
});
const log = await jiti.import("../src/session-log.ts");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "horde-session-log-"));
const runDir = fs.mkdtempSync(path.join(SCRATCH, "session-log-fixture-"));
const file = path.join(runDir, "sessions", "member-1", "2026-09-13T05-03-42-004Z_abc.jsonl");
const bigText = "x".repeat(5000);
const lines = [
  JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "2026-09-13T05:03:42.004Z", cwd: "/p" }),
  JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-13T05:03:42.100Z", provider: "deepseek", modelId: "v4" }),
  JSON.stringify({ type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-13T05:03:42.121Z", message: { role: "user", content: [{ type: "text", text: "do the task" }], timestamp: 1 } }),
  JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-13T05:03:43.598Z", message: { role: "assistant", content: [
    { type: "thinking", thinking: "let me think about this" },
    { type: "text", text: bigText },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "/p/IDEAS.md" } },
    { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls -la" } },
  ], model: "v4", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: { total: 0.01 } }, stopReason: "toolUse" } }),
  JSON.stringify({ type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-13T05:03:43.604Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "# Ideas" }], isError: false } }),
  JSON.stringify({ type: "message", id: "r2", parentId: "r1", timestamp: "2026-09-13T05:03:43.700Z", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true } }),
  "this is not json",
  JSON.stringify({ type: "message", id: "a2", parentId: "r2", timestamp: "2026-09-13T05:03:50.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } }, stopReason: "stop" } }),
];
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, lines.join("\n") + "\n" + '{"type":"message","id":"partial"');

const page = log.readSessionPage(file, 0, 3);
assert.equal(page.total, 7, "garbage and partial trailing lines are dropped");
assert.equal(page.entries.length, 3);
assert.equal(page.hasMore, true);
assert.equal(page.sessionId, "abc");
assert.equal(page.cwd, "/p");
assert.equal(page.entries[0].kind, "session");
assert.equal(page.entries[1].detail, "deepseek/v4");
assert.equal(page.entries[2].role, "user");
assert.deepEqual(page.entries[2].parts, [{ type: "text", text: "do the task", truncated: false }]);

const assistant = log.readSessionPage(file, 3, 1).entries[0];
assert.equal(assistant.role, "assistant");
assert.equal(assistant.index, 3);
assert.deepEqual(assistant.usage, { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: 0.01 });
assert.deepEqual(assistant.parts[0], { type: "thinking", chars: 23 });
assert.equal(assistant.parts[1].type, "text");
assert.equal(assistant.parts[1].text.length, 4000);
assert.equal(assistant.parts[1].truncated, true);
assert.equal(assistant.parts[2].type, "toolCall");
assert.equal(assistant.parts[2].name, "read");
assert.equal(assistant.parts[2].summary, "/p/IDEAS.md");
assert.equal(assistant.parts[3].summary, "ls -la");

const tail = log.readSessionPage(file, "last", 2);
assert.equal(tail.from, 5);
assert.equal(tail.entries.length, 2);
assert.equal(tail.hasMore, false);
assert.equal(tail.entries[0].isError, true);
assert.equal(tail.entries[0].toolName, "bash");

assert.equal(log.readSessionPage(file, 999, 5).entries.length, 0);
assert.equal(log.readSessionPage(file, 0, 999).n, 200);
assert.equal(log.readSessionPage(file, 0, 0).n, 1);

const full = log.readSessionEntry(file, 3);
assert.equal(full.parts[0].thinking, "let me think about this");
assert.equal(full.parts[1].text.length, 5000);
assert.equal(full.parts[1].truncated, false);
assert.equal(log.readSessionEntry(file, 99), undefined);
assert.match(log.rawSessionEntry(file, 2), /"role": "user"/);

const stats = log.sessionStats(file);
assert.deepEqual(stats, {
  entries: 7, turns: 2, toolCalls: 2,
  usage: { input: 150, output: 25, cacheRead: 5, cacheWrite: 1, cost: 0.012 },
  first: "2026-09-13T05:03:42.100Z", last: "2026-09-13T05:03:50.000Z",
});
assert.equal(log.sessionStats(file), stats, "cached object is reused while the file is unchanged");

assert.equal(log.memberSessionFile(runDir, "member-1"), file);
assert.equal(log.memberSessionFile(runDir, "member-2"), undefined);
assert.equal(log.memberSessionFile(runDir, "member-9"), undefined);
assert.deepEqual(log.listSessionFiles("/nonexistent"), []);
const listed = log.listSessionFiles(path.join(runDir, "sessions", "member-1"));
assert.equal(listed.length, 1);
assert.equal(listed[0].sessionId, "abc");
assert.equal(log.sessionIdFromName("2026-09-13T05-03-42-004Z_01a09926-57b4.jsonl"), "01a09926-57b4");

// Legacy flat sessions dir: a run whose sessions are flat files, not per-member dirs.
const realRun = path.join(SCRATCH, "realrun");
const realDir = path.join(realRun, "sessions");
fs.mkdirSync(realDir, { recursive: true });
const realEntries = [
  { type: "session", id: "real", cwd: "/p", timestamp: "2026-09-13T05:03:42.004Z" },
  { type: "message", timestamp: "2026-09-13T05:03:43.000Z", message: { role: "user", content: "go" } },
  { type: "message", timestamp: "2026-09-13T05:03:44.000Z", message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, content: [{ type: "text", text: "a" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } }] } },
  { type: "message", timestamp: "2026-09-13T05:03:45.000Z", message: { role: "assistant", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } }] } },
];
fs.writeFileSync(
  path.join(realDir, "2026-09-13T05-03-42-004Z_deadbeef.jsonl"),
  `${realEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
);
const realFiles = log.listSessionFiles(realDir);
assert.equal(realFiles.length, 1, "legacy flat sessions dir lists its files");
const real = log.sessionStats(path.join(realDir, realFiles[0].name));
assert.equal(real.turns, 2);
assert.equal(real.toolCalls, 2);
assert.ok(real.usage.input > 0);
assert.equal(log.memberSessionFile(realRun, "member-1"), undefined);

const huge = path.join(SCRATCH, "huge.jsonl");
fs.writeFileSync(huge, "");
fs.truncateSync(huge, log.MAX_SESSION_BYTES + 1);
assert.throws(() => log.readSessionPage(huge, 0, 1), log.SessionTooLargeError);
fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log("PASS: horde-session-log-test");
