// A session that ends cleanly but calls no tool filed nothing: it gets the end cause `no_work`,
// is not reset into a fresh session that would do the same, and its message is kept out of the
// work summary. Doubles as the fake child: member-2 prints a line and exits 0 with no tool call;
// member-1 (canary) and member-3 stay alive until the run is stopped.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const DECLINE = "I will not do this task.";

if (process.argv.includes("--mode")) {
  const name = process.env.PI_HORDE_NAME;
  const countFile = path.join(process.env.NO_WORK_PROBE_DIR, `${name}.spawns`);
  fs.writeFileSync(countFile, String((fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf-8")) : 0) + 1));
  emit({ type: "agent_start" });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: name === "member-2" ? DECLINE : "working" }], usage, stopReason: "stop" } });
  if (name === "member-2") {
    await wait(100);
    process.exit(0);
  }
  setInterval(() => {}, 1000);
} else {
  for (const key of ["PI_HORDE_MEMBER", "PI_HORDE_DIR", "PI_HORDE_NAME", "PI_HORDE_RUN"]) delete process.env[key];
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "2000";
  process.env.PI_HORDE_STALL_MS = "0";
  process.env.PI_HORDE_RESET_CAP = "2";

  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": PI,
      "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
      "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
      typebox: `${DEPS}/typebox/build/index.mjs`,
    },
  });
  const member = await jiti.import("../src/member.ts");
  const mod = await jiti.import("../src/index.ts");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-no-work-"));
  const probeDir = path.join(cwd, "probe");
  fs.mkdirSync(probeDir);
  process.env.NO_WORK_PROBE_DIR = probeDir;
  const hordeDir = path.join(cwd, ".horde");
  const commands = new Map();
  const notifications = [];
  const pi = { registerTool: () => {}, registerCommand: (n, d) => commands.set(n, d), registerMessageRenderer: () => {}, on: () => {}, sendMessage: () => {} };
  mod.default(pi);
  const ui = { notify: (t, l) => notifications.push(`${l}: ${t}`), setWidget: () => {}, setStatus: () => {} };
  const ctx = { cwd, hasUI: false, ui, model: undefined, thinkingLevel: undefined, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");
  const runDirs = () => fs.readdirSync(path.join(hordeDir, "runs")).sort();
  const log = (dir, name) => fs.readFileSync(path.join(dir, `${name}.log`), "utf-8");
  const count = (text, re) => (text.match(re) ?? []).length;

  await command.handler("--no-verifier 3 no-work probe", ctx);
  const dir = path.join(hordeDir, "runs", runDirs()[0]);
  for (let i = 0; i < 60 && !/ended with no tool calls/.test(fs.existsSync(path.join(dir, "member-2.log")) ? log(dir, "member-2") : ""); i++) await wait(100);

  const m2 = log(dir, "member-2");
  assert.equal(count(m2, /^\[horde\] spawn:/gm), 1, `a no-work member is not respawned:\n${m2}`);
  assert.match(m2, /^\[horde\] exit code 0 status done cause no_work$/m);
  assert.match(m2, /^\[horde\] ended with no tool calls; not reset$/m);
  assert.doesNotMatch(m2, /^\[horde\] reset/m);
  assert.equal(member.parseMemberLog(m2).endCause, "no_work");

  const board = fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf-8");
  assert.match(board, /member-2 stays down: its session ended without calling any tool, so it filed no work\./);

  await command.handler("stop-hard", ctx);
  for (let i = 0; i < 60 && !fs.existsSync(path.join(dir, "REPORT.md")); i++) await wait(100);
  const report = fs.readFileSync(path.join(dir, "REPORT.md"), "utf-8");
  assert.match(report, /^- member-2: done \(no_work\) /m);
  assert.match(report, /abnormal ends: .*member-2 \(no_work\)/);
  assert.doesNotMatch(report.split("\n").find((l) => l.startsWith("- resets: ")) ?? "", /member-2/);

  const summary = fs.readFileSync(path.join(dir, "SUMMARY.md"), "utf-8");
  assert.match(summary, /the member made no tool calls and filed nothing; its message is omitted/);
  assert.ok(!summary.includes(DECLINE), "the member's refusal text is kept out of the work summary");
  assert.ok(!report.includes(DECLINE), "the member's refusal text is kept out of the report");

  const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.action === "member-exit" && e.payload.member === "member-2" && e.payload.endCause === "no_work"), "member-exit records the cause");

  fs.rmSync(cwd, { recursive: true, force: true });
  console.log("PASS: horde-no-work-test");
  process.exit(0);
}
