// Goal reminders: the member-side tool appends a restatement of the task, role,
// and claimed work every N calls or M ms, never during a clean stop; mutating
// actions also touch the member's heartbeat file.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

process.env.PI_HORDE_REMIND_CALLS = "3";
process.env.PI_HORDE_REMIND_MS = "0";
delete process.env.PI_HORDE_MEMBER;

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": PI,
    "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
    "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
    typebox: `${DEPS}/typebox/build/index.mjs`,
  },
});
const { ReminderGate, goalReminder } = await jiti.import("../src/reminder.ts");
const prompt = await jiti.import("../src/prompt.ts");
const ledger = {
  ...(await jiti.import("../src/ledger/board.ts")),
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/run-signals.ts")),
};
const { default: extension } = await jiti.import("../src/index.ts");

// The gate: by calls, by time with an injected clock, and never when both are off.
const byCalls = new ReminderGate(3, 0, 1000);
assert.deepEqual([byCalls.tick(1001), byCalls.tick(1002), byCalls.tick(1003)], [false, false, true]);
assert.deepEqual([byCalls.tick(1004), byCalls.tick(1005), byCalls.tick(1006)], [false, false, true], "counters restart");
const byTime = new ReminderGate(0, 500, 1000);
assert.equal(byTime.tick(1400), false);
assert.equal(byTime.tick(1500), true);
assert.equal(byTime.tick(1600), false, "the clock restarts at the reminder");
const either = new ReminderGate(10, 500, 1000);
assert.equal(either.tick(1600), true, "time fires before the call count");
const never = new ReminderGate(0, 0, 1000);
assert.equal([1, 2, 3, 4, 5].some(() => never.tick(9_999_999)), false);

// The reminder text reads TASK.md and the member's claimed ideas.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-reminder-"));
const hordeDir = ledger.initHordeDir(cwd);
const runDir = path.join(hordeDir, "runs", "R1");
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(
  path.join(runDir, "TASK.md"),
  prompt.taskMarkdown({ id: "R1", prompt: "audit the payments service for authz gaps", count: 3, startedAt: Date.now(), verifier: "member-3" }),
);
assert.equal(goalReminder(hordeDir, "missing-run", "member-2", undefined), "", "unreadable run files yield no reminder");
const bare = goalReminder(hordeDir, "R1", "member-2", undefined);
assert.match(bare, /--- goal reminder \(run R1\) ---/);
assert.match(bare, /Task: audit the payments service for authz gaps/);
assert.match(bare, /You are member-2\. No assigned role\./);
assert.match(bare, /Claimed: none/);

// Through the member tool: the third call carries the reminder, with role and claim.
process.env.PI_HORDE_MEMBER = "1";
process.env.PI_HORDE_DIR = hordeDir;
process.env.PI_HORDE_NAME = "member-2";
process.env.PI_HORDE_RUN = "R1";
process.env.PI_HORDE_ROLE = "You own workstream 2 \"payments\".";
const pi = { tools: {}, registerTool: (tool) => { pi.tools[tool.name] = tool; }, registerCommand: () => {}, registerMessageRenderer: () => {}, on: () => {}, sendMessage: () => {} };
extension(pi);
let callId = 0;
const call = (params) => pi.tools.horde.execute(`call-${++callId}`, params, undefined, undefined, {}).then((r) => r.content[0].text);
const hb = path.join(runDir, ".hb-member-2");
await ledger.appendRunHeading(hordeDir, "R1", "reminder probe");
assert.doesNotMatch(await call({ action: "list" }), /goal reminder/);
assert.ok(!fs.existsSync(hb), "a read does not touch the heartbeat");
const added = await call({ action: "idea", text: "check refund authz" });
assert.doesNotMatch(added, /goal reminder/);
assert.ok(fs.existsSync(hb), "a ledger write touches the heartbeat");
const third = await call({ action: "claim", id: 1 });
assert.match(third, /^Claimed #1: check refund authz/);
assert.match(third, /--- goal reminder \(run R1\) ---/);
assert.match(third, /You are member-2\. You own workstream 2 "payments"\./);
assert.match(third, /Claimed: #1 check refund authz/);
assert.match(third, /If you have not claimed work or recorded evidence since the last reminder, do so or stop\./);
assert.doesNotMatch(await call({ action: "list" }), /goal reminder/, "the counter restarted");

// During a clean stop the reminder is suppressed: the stop notice already says what to do.
ledger.writeCleanStop(runDir, { runId: "R1", members: [], at: new Date().toISOString() });
for (let i = 0; i < 4; i++) assert.doesNotMatch(await call({ action: "list" }), /goal reminder/);
ledger.clearCleanStop(runDir);

fs.rmSync(cwd, { recursive: true, force: true });
console.log("PASS: horde-reminder-test");
