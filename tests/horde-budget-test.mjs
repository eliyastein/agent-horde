// --budget: the run clean-stops itself once the members' combined spend, counted over every
// session they have had, reaches the ceiling. Doubles as the fake child: every session reports
// one assistant message costing $0.30 and exits 0, so under --until-stop the continuations keep
// spending until the budget trips.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--mode")) {
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  process.stdout.write(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "spent a little" }],
        usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.3 } },
        stopReason: "stop",
      },
    }) + "\n",
  );
  await wait(300);
  process.exit(0);
} else {
  delete process.env.PI_HORDE_MEMBER;
  delete process.env.PI_HORDE_DIR;
  delete process.env.PI_HORDE_NAME;
  delete process.env.PI_HORDE_RUN;
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "2000";
  process.env.PI_HORDE_CONTINUE_COOLDOWN_MS = "200";
  process.env.PI_HORDE_RESET_CAP = "0";

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
  const budget = await jiti.import("../src/run/budget.ts");
  const member = await jiti.import("../src/member.ts");

  // ---- the check itself: swarm-wide sum, one trip, finished hordes left alone ----------
  const slot = (cost) => Object.assign(member.newMemberState(1), { lifetime: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost } });
  const fakeSwarm = { id: "sw", budget: 1, runs: [{ members: [slot(0.6)], reported: true, finalized: true }, { members: [slot(0.5)], stopped: true }] };
  assert.equal(budget.swarmSpend(fakeSwarm).toFixed(2), "1.10", "spend is summed across the hordes");
  const notes = [];
  const fakeCtx = { ui: { notify: (text, level) => notes.push(`${level}: ${text}`) } };
  budget.checkBudget({ state: { disposed: false }, swarm: fakeSwarm, ctx: fakeCtx });
  assert.equal(fakeSwarm.budgetHit, true);
  assert.deepEqual(notes, ["warning: horde sw: budget reached ($1.10 of $1.00); stopping"]);
  budget.checkBudget({ state: { disposed: false }, swarm: fakeSwarm, ctx: fakeCtx });
  assert.equal(notes.length, 1, "the trip is requested once");
  const under = { id: "sw2", budget: 5, runs: [{ members: [slot(0.6)] }] };
  budget.checkBudget({ state: { disposed: false }, swarm: under, ctx: fakeCtx });
  assert.equal(under.budgetHit, undefined, "under budget nothing happens");
  budget.checkBudget({ state: { disposed: false }, swarm: { id: "sw3", runs: [{ members: [slot(9)] }] }, ctx: fakeCtx });
  assert.equal(notes.length, 1, "no budget, no check");
  console.log("PASS: horde-budget-test check");

  // ---- a live run stops itself at the ceiling -----------------------------------------
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-budget-"));
  const hordeDir = path.join(cwd, ".horde");
  const commands = new Map();
  const notifications = [];
  const sent = [];
  const pi = {
    registerTool: () => {},
    registerCommand: (n, d) => commands.set(n, d),
    registerMessageRenderer: () => {},
    on: () => {},
    sendMessage: (msg, opts) => sent.push({ msg, opts }),
  };
  mod.default(pi);
  const ui = { notify: (t, l) => notifications.push(`${l}: ${t}`), setWidget: () => {}, setStatus: () => {} };
  const ctx = { cwd, hasUI: false, ui, model: undefined, thinkingLevel: undefined, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");

  await command.handler("2 --until-stop --budget 1 budget probe", ctx);
  const run = fs.readdirSync(path.join(hordeDir, "runs")).sort()[0];
  const dir = path.join(hordeDir, "runs", run);
  const reportPath = path.join(dir, "REPORT.md");
  for (let i = 0; i < 100 && !fs.existsSync(reportPath); i++) await wait(200);
  assert.ok(fs.existsSync(reportPath), `the run stopped itself and finalized:\n${notifications.join("\n")}`);

  assert.match(fs.readFileSync(path.join(dir, "TASK.md"), "utf-8"), /^Budget: \$1\.00 \(the run clean-stops when member spend reaches it\)$/m);
  const report = fs.readFileSync(reportPath, "utf-8");
  assert.match(report, /^- outcome: stopped-clean$/m);
  assert.match(fs.readFileSync(path.join(dir, "SUMMARY.md"), "utf-8"), /Run stopped at budget\. Outcome: stopped-clean\./);
  const reported = Number(/\$(\d+\.\d+) cost \(budget \$1\.00\)/.exec(report)?.[1]);
  assert.ok(reported >= 1, `REPORT.md counts every session: ${report.split("\n").find((l) => l.startsWith("Usage:"))}`);

  const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(events.find((e) => e.action === "run-start").payload.budget, 1);
  const stops = events.filter((e) => e.action === "stop-clean");
  assert.equal(stops.length, 1, "one clean stop was requested");
  assert.equal(stops[0].payload.label, "budget");
  assert.deepEqual(stops[0].payload.members, ["member-1", "member-2"]);
  const end = events.find((e) => e.action === "run-end");
  assert.ok(end.payload.spent >= 1, `run-end records the spend: ${JSON.stringify(end.payload)}`);
  assert.equal(end.payload.budget, 1);
  assert.equal(end.payload.stopLabel, "stopped at budget");
  const exits = events.filter((e) => e.action === "member-exit");
  assert.ok(exits.length >= 3, "the continuations kept spending until the budget tripped");
  assert.ok(exits.every((e) => Math.abs(e.payload.cost - 0.3) < 1e-9), "member-exit records the session's own cost");

  assert.ok(notifications.some((n) => /budget reached \(\$\d+\.\d+ of \$1\.00\); stopping/.test(n)), notifications.join("\n"));
  assert.ok(notifications.some((n) => /budget: 2 member\(s\) wrapping up/.test(n)), notifications.join("\n"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.triggerTurn, true, "a budget stop is a clean stop");

  const spawns = () => ["member-1", "member-2"].reduce((n, name) => n + (fs.readFileSync(path.join(dir, `${name}.log`), "utf-8").match(/^\[horde\] spawn:/gm) ?? []).length, 0);
  const before = spawns();
  await wait(1000);
  assert.equal(spawns(), before, "no continuation after the stop");

  console.log("PASS: horde-budget-test");
  process.exit(0);
}
