// Clean stop while a member is inside a tool call: the member hears of the stop only when the
// call returns, so the deadline is held once to give it wrap-up time after that. Doubles as the
// fake child: one bash call that runs for 2.5s, then a final message, then exit 0.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const message = (text) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop" },
});

if (process.argv.includes("--mode")) {
  emit({ type: "agent_start" });
  emit(message("starting a long call"));
  emit({ type: "tool_execution_start", toolName: "bash", args: { command: "sleep 2.5" } });
  await wait(2500);
  emit({ type: "tool_execution_end", toolName: "bash" });
  await wait(500);
  emit(message("Recorded what the call returned."));
  process.exit(0);
} else {
  for (const key of ["PI_HORDE_MEMBER", "PI_HORDE_DIR", "PI_HORDE_NAME", "PI_HORDE_RUN"]) delete process.env[key];
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "200";
  process.env.PI_HORDE_ACTIVE_GRACE_MS = "50";
  process.env.PI_HORDE_WRAP_UP_MS = "1000";
  process.env.PI_HORDE_LATE_CAP_MS = "3000";

  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": PI,
      "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
      "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
      typebox: `${DEPS}/typebox/build/index.mjs`,
    },
  });
  const mod = await jiti.import("../src/index.ts");
  const controls = await jiti.import("../src/run/controls.ts");
  const member = await jiti.import("../src/member.ts");

  // ---- what the deadline owes each member ------------------------------------------------
  const slot = (name, extra) => Object.assign(member.newMemberState(1), { name, ...extra });
  const now = 100_000;
  assert.deepEqual(controls.lateWrapUpHold([slot("a")], now), { holdMs: 0, names: [] }, "a member that was between calls is owed nothing");
  assert.deepEqual(controls.lateWrapUpHold([slot("a", { stopCallPending: true })], now), { holdMs: 3000, names: ["a"] }, "a call still running gets the cap");
  assert.deepEqual(
    controls.lateWrapUpHold([slot("a", { stopCallEndedAt: now - 400 }), slot("b", { stopCallEndedAt: now - 5000 }), slot("c")], now),
    { holdMs: 600, names: ["a"] },
    "a call that returned 0.4s ago is owed the rest of its second; one that returned long ago is owed nothing",
  );
  const state = slot("a", { stopCallPending: true, currentTool: "bash" });
  member.applyEvent(state, { type: "tool_execution_end", toolName: "bash" });
  assert.equal(state.stopCallPending, undefined);
  assert.ok(Date.now() - state.stopCallEndedAt < 1000, "the return of the in-flight call is timed");
  console.log("PASS: horde-stop-inflight-test check");

  // ---- a live run: stop-clean with a 1s grace lands inside the 2.5s call -----------------
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-stop-inflight-"));
  const commands = new Map();
  const notifications = [];
  const pi = { registerTool: () => {}, registerCommand: (n, d) => commands.set(n, d), registerMessageRenderer: () => {}, on: () => {}, sendMessage: () => {} };
  mod.default(pi);
  const ui = { notify: (t, l) => notifications.push(`${l}: ${t}`), setWidget: () => {}, setStatus: () => {} };
  const ctx = { cwd, hasUI: false, ui, model: undefined, thinkingLevel: undefined, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");

  await command.handler("1 in-flight probe", ctx);
  const runs = path.join(cwd, ".horde", "runs");
  const dir = path.join(runs, fs.readdirSync(runs).sort()[0]);
  const events = () => fs.readFileSync(path.join(dir, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  await wait(700);
  await command.handler("stop-clean --grace 1", ctx);
  for (let i = 0; i < 100 && !events().some((e) => e.action === "run-end"); i++) await wait(200);
  const all = events();
  const holds = all.filter((e) => e.action === "stop-hold");
  assert.equal(holds.length, 1, `the deadline was held once:\n${notifications.join("\n")}`);
  assert.deepEqual(holds[0].payload.members, ["member-1"]);
  assert.equal(holds[0].payload.reason, "tool-in-flight");
  assert.equal(holds[0].payload.holdMs, 3000);
  assert.ok(!all.some((e) => e.action === "stop-hard"), "the member finished inside the hold, so nothing was terminated");
  const exit = all.find((e) => e.action === "member-exit");
  assert.equal(exit.payload.status, "done", JSON.stringify(exit.payload));

  console.log("PASS: horde-stop-inflight-test");
  process.exit(0);
}
