// Clean-stop wind-down in the member process: once the sentinel names the member, every tool but
// `horde` is refused with wrap-up instructions, one wrap-up message is inserted at the next turn
// boundary, and the horde actions that record work stay available.
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
const actions = await jiti.import("../src/tool/actions.ts");
const { registerWindDown } = await jiti.import("../src/tool/wind-down.ts");
const { initHordeDir } = await jiti.import("../src/ledger/files.ts");
const { appendRunHeading } = await jiti.import("../src/ledger/board.ts");
const signals = await jiti.import("../src/ledger/run-signals.ts");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-wind-down-"));
const hordeDir = initHordeDir(cwd);
const runId = "R1";
const runDir = path.join(hordeDir, "runs", runId);
await appendRunHeading(hordeDir, runId, "wind-down probe");
fs.mkdirSync(runDir, { recursive: true });

const hooks = (member) => {
  const handlers = new Map();
  registerWindDown({ on: (name, fn) => handlers.set(name, fn) }, { hordeDir, runId, member });
  return handlers;
};
const boundary = { outcome: "completed", context: { canContinue: true } };
const bash = { type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "curl example.test" } };
const horde = { type: "tool_call", toolName: "horde", toolCallId: "t2", input: { action: "finding" } };
const stop = (members, label) => signals.writeCleanStop(runDir, { runId, members, at: new Date().toISOString(), label });

// A member holds an idea with unrecorded work when the stop arrives.
const run = (params) => actions.runHordeAction(hordeDir, "member-1", params, runId);
await run({ action: "idea", text: "probe the press gallery pagination" });
await run({ action: "claim", id: 1 });

// No stop pending: nothing is blocked and nothing is inserted.
const one = hooks("member-1");
assert.equal(one.get("tool_call")(bash), undefined);
assert.equal(one.get("turn_end")(boundary), undefined);

// A stop naming only member-2 leaves member-1 alone.
stop(["member-2"], "stop-clean");
assert.equal(one.get("tool_call")(bash), undefined, "a member the targeted stop does not name keeps its tools");
assert.equal(one.get("turn_end")(boundary), undefined);
const two = hooks("member-2");
const targeted = two.get("tool_call")(bash);
assert.equal(targeted.block, true);
assert.match(targeted.reason, /the user asked the run to stop/);

// A stop for another run id is ignored.
signals.writeCleanStop(runDir, { runId: "R0", members: [], at: "", label: "budget" });
assert.equal(two.get("tool_call")(bash), undefined, "a sentinel left by another run blocks nothing");

// A stop for everyone: non-horde tools are refused with the reason and what to do instead.
stop([], "budget");
const blocked = one.get("tool_call")(bash);
assert.equal(blocked.block, true);
assert.match(blocked.reason, /this bash call was not executed/);
assert.match(blocked.reason, /the run reached its budget/);
assert.match(blocked.reason, /finding, fact/);
assert.equal(blocked.terminate, undefined, "the member is left its turn to record what it has");
assert.equal(one.get("tool_call")(horde), undefined, "the horde tool is never blocked");
assert.equal(one.get("tool_call")({ ...bash, toolName: "read" }).block, true);

// One wrap-up message at the next boundary, so a member that calls no tools sees it too.
assert.equal(one.get("turn_end")({ outcome: "aborted", context: { canContinue: true } }), undefined);
assert.equal(one.get("agent_before_settle")({ outcome: "completed", context: { canContinue: false } }), undefined);
const inserted = one.get("agent_before_settle")(boundary);
assert.equal(inserted.continue, true);
assert.equal(inserted.entries.length, 1);
assert.equal(inserted.entries[0].customType, "horde-wind-down");
assert.match(inserted.entries[0].content, /winding down: the run reached its budget/);
assert.match(inserted.entries[0].content, /Unrecorded work is lost/);
assert.equal(one.get("turn_end")(boundary), undefined, "the wrap-up message is inserted once per session");
one.get("session_compact")();
assert.ok(one.get("turn_end")(boundary), "a compacted session is told again");

// The reason differs by label; an unknown or missing label reads as a user stop.
stop([], "solved");
const solved = hooks("member-1").get("turn_end")(boundary).entries[0].content;
assert.match(solved, /a validated answer exists/);
assert.doesNotMatch(solved, /Unrecorded work is lost/);
stop([], "deadline");
assert.match(hooks("member-1").get("tool_call")(bash).reason, /the run reached its time limit/);
signals.writeCleanStop(runDir, { runId, members: [], at: "" });
assert.match(hooks("member-1").get("tool_call")(bash).reason, /the user asked the run to stop/);

// Recording stays possible during wind-down; starting new work does not.
const finding = await run({
  action: "finding", idea: 1, concern: "press-gallery-pagination",
  concernDef: "press gallery pagination depth and what each page yields", support: "tested",
  text: "Gallery pages 1-3 yield 40 photos\npages 4+ not fetched before the stop",
});
assert.match(finding.text, /F1/);
const refused = await run({ action: "idea", text: "a brand new line of work" });
assert.match(refused.text, /A clean stop is in effect/);
assert.match(refused.text, /File the findings and facts/);
const done = await run({ action: "done", id: 1, text: "pages 1-3 harvested, 4+ left" });
assert.match(done.text, /Done #1/);

// A pi build without hooks is tolerated.
registerWindDown({}, { hordeDir, runId, member: "member-1" });

console.log("ok");
