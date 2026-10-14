import assert from "node:assert/strict";
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
const widget = await jiti.import("../src/widget.ts");
const member = await jiti.import("../src/member.ts");
const prompt = await jiti.import("../src/prompt.ts");

const theme = { fg: (_c, s) => s, bold: (s) => s };
const now = 100_000;
const mk = (i, patch) => Object.assign(member.newMemberState(i), { startedAt: now - 65_000 }, patch);
const run = {
  id: "20260913-140200",
  prompt: "find auth bypasses",
  count: 5,
  startedAt: now - 135_000,
  stopped: false,
  members: [
    mk(1, { status: "running", currentTool: "bash", currentArg: 'grep -rn "jwt" src', turns: 3 }),
    mk(2, { status: "running", streaming: "text", turns: 2 }),
    mk(3, { status: "done", turns: 3, endedAt: now - 24_000, usage: { input: 12_000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0 } }),
    mk(4, { status: "failed", error: "exit 1: ECONNREFUSED", endedAt: now - 60_000 }),
    mk(5, { status: "starting" }),
  ],
};

const lines = widget.widgetLines(run, now, 120, theme);
assert.equal(lines.length, 6);
assert.match(lines[0], /^horde 20260913-140200  3 running  1 done  1 failed  02:15  \/agent-horde status \| stop-hard \| stop-clean$/);
assert.match(lines[1], /^ ⠋ member-1  running  bash: grep -rn "jwt" src  01:05  t3$/);
assert.match(lines[2], /^ ⠋ member-2  running  writing\.\.\.  01:05  t2$/);
assert.match(lines[3], /^ ✓ member-3  done     3 turns  12\.4k tok  00:41  t3$/);
assert.match(lines[4], /^ ✗ member-4  failed   exit 1: ECONNREFUSED  00:05  t0$/);
assert.match(lines[5], /^ · member-5  starting starting  01:05  t0$/);

const narrow = widget.widgetLines(run, now, 30, theme);
// oxlint-disable-next-line no-control-regex -- matches ANSI escape sequences
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
for (const line of narrow) assert.ok(stripAnsi(line).length <= 30, line);

const big = { ...run, count: 10, members: Array.from({ length: 10 }, (_, i) => mk(i + 1, { status: i === 2 ? "failed" : "running" })) };
const collapsed = widget.widgetLines(big, now, 120, theme);
assert.equal(collapsed.length, 3);
assert.equal(collapsed[1], " ⠋ ⠋ ✗ ⠋ ⠋ ⠋ ⠋ ⠋ ⠋ ⠋");
assert.equal(collapsed[2], " failed: member-3");

const paused = { ...run, members: run.members.map((m, i) => (i === 0 ? { ...m, paused: true } : m)) };
const pausedLines = widget.widgetLines(paused, now, 120, theme);
assert.match(pausedLines[1], /^ ⏸ member-1  running  paused  01:05  t3$/);

const w = new widget.HordeWidget(run, theme, () => now);
assert.deepEqual(w.render(120), lines);
w.invalidate();

const status = prompt.formatStatusReport(run, now);
assert.match(status, /^horde 20260913-140200  3 running  1 done  1 failed  0 stopped  02:15\n/);
assert.match(status, /member-4 {3}failed {3}exit 1: ECONNREFUSED/);

const summary = prompt.summaryMarkdown(run, now);
assert.match(summary, /^# Horde run 20260913-140200\n/);
assert.match(summary, /1 done, 1 failed, 0 stopped\./);
assert.match(summary, /## member-4: failed\n\n0 turns, 0 tool calls, 0 in \/ 0 out, 00:05\nexit code n\/a\n\n```\nexit 1: ECONNREFUSED\n```/);
const report = prompt.reportText(run, { open: 2, inProgress: 1, done: 7 }, 6, now);
assert.match(report, /^Horde run 20260913-140200 finished after 02:15: 1 of 5 members done, 1 failed, 0 stopped \(member-4: exit 1: ECONNREFUSED\)\./);
assert.match(report, /This run added 6 findings; IDEAS\.md now has 7 done, 1 in progress, 2 open, 0 ruled out\./);
assert.ok(prompt.memberSystemPrompt({ hordeDir: "/x/.horde", count: 4 }).includes("horde of 4 agents"));

const withUrl = widget.widgetLines({ ...run, dashboardUrl: "http://127.0.0.1:7433/" }, now, 160, theme);
assert.match(withUrl[0], /02:15  http:\/\/127\.0\.0\.1:7433\/runs\/20260913-140200  \/agent-horde status/);
console.log("PASS: horde-widget-test");
