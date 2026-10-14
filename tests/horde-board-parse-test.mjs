import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const ledger = {
  ...(await jiti.import("../src/ledger/board.ts")),
  ...(await jiti.import("../src/ledger/files.ts")),
};
const prompt = await jiti.import("../src/prompt.ts");

const fixture = [
  "# Board",
  "",
  "### 00:00:01 parent",
  "before any run",
  "",
  "## Run 20260913-010151 (2026-09-13 01:01:51): first prompt",
  "",
  "### 01:01:55 member-2",
  "line one",
  "\\## escaped heading",
  "",
  "line after blank",
  "",
  "## Run 20260913-010341 (2026-09-13 01:03:41): second prompt",
  "",
  "### 01:03:55 member-1",
  "truncated last entry",
].join("\n");
const entries = ledger.parseBoard(fixture);
assert.equal(entries.length, 3);
assert.deepEqual(entries[0], { runId: "", time: "00:00:01", author: "parent", text: "before any run" });
assert.deepEqual(entries[1], {
  runId: "20260913-010151",
  time: "01:01:55",
  author: "member-2",
  text: "line one\n## escaped heading\n\nline after blank",
});
assert.deepEqual(entries[2], {
  runId: "20260913-010341", time: "01:03:55", author: "member-1", text: "truncated last entry",
});
assert.deepEqual(ledger.parseBoard(""), []);
assert.deepEqual(ledger.parseBoard("# Board\n\n## Run X (now): p\n"), []);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-board-parse-"));
const tmpHorde = ledger.initHordeDir(tmp);
await ledger.appendRunHeading(tmpHorde, "20260913-010341", "p");
await ledger.postBoard(tmpHorde, "member-2", "hello");
const real = ledger.listBoard(tmpHorde);
assert.equal(real.length, 1);
assert.equal(real[0].runId, "20260913-010341");
assert.equal(real[0].author, "member-2");
assert.deepEqual(ledger.listBoard("/nonexistent/.horde"), []);
fs.rmSync(tmp, { recursive: true, force: true });

const task = prompt.taskMarkdown({
  id: "20260913-010341", prompt: "evaluate\nthe thing", count: 3,
  model: "deepseek/deepseek-v4-flash", thinkingLevel: "medium", startedAt: Date.parse("2026-09-13T01:03:41"),
});
assert.deepEqual(prompt.parseTaskMarkdown(task), {
  id: "20260913-010341",
  started: "2026-09-13 01:03:41",
  count: 3,
  model: "deepseek/deepseek-v4-flash",
  thinking: "medium",
  hash: "32ee2e468f30",
  prompt: "evaluate\nthe thing",
});
assert.deepEqual(prompt.parseTaskMarkdown(""), { prompt: "" });
assert.equal(prompt.parseReportOutcome("# Run report\n\n## Diagnosis\n\n- outcome: stopped-clean\n- canary: ok\n"), "stopped-clean");
assert.equal(prompt.parseReportOutcome("no outcome here"), undefined);
console.log("PASS: horde-board-parse-test");
