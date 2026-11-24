// --budget: the run clean-stops itself once the members' combined spend, counted over every
// session they have had, comes within the wrap-up reserve of the ceiling, and a continuation the
// remainder cannot pay for is not started. Doubles as the fake child: every session reports one
// thirty assistant messages of one cent each, $0.30 a session, and exits 0.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--mode")) {
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  for (let turn = 0; turn < 30; turn++) {
    process.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "spent a little" }],
          usage: { input: 5, output: 1, cacheRead: 7, cacheWrite: 0, cost: { total: 0.01 } },
          stopReason: "stop",
        },
      }) + "\n",
    );
  }
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
  const { budgetReserve } = await jiti.import("../src/prompt.ts");

  // ---- the check itself: swarm-wide sum, one trip, finished hordes left alone ----------
  const slot = (cost) => Object.assign(member.newMemberState(1), { lifetime: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost } });
  const fakeSwarm = { id: "sw", budget: 1, runs: [{ members: [slot(0.6)], reported: true, finalized: true }, { members: [slot(0.5)], stopped: true }] };
  assert.equal(budget.swarmSpend(fakeSwarm).toFixed(2), "1.10", "spend is summed across the hordes");
  const notes = [];
  const fakeCtx = { ui: { notify: (text, level) => notes.push(`${level}: ${text}`) } };
  budget.checkBudget({ state: { disposed: false }, swarm: fakeSwarm, ctx: fakeCtx });
  assert.equal(fakeSwarm.budgetHit, true);
  assert.deepEqual(notes, ["warning: horde sw: budget reached ($1.10 of $1.00, $0.05 held for wrap-up); stopping"]);
  budget.checkBudget({ state: { disposed: false }, swarm: fakeSwarm, ctx: fakeCtx });
  assert.equal(notes.length, 1, "the trip is requested once");
  const under = { id: "sw2", budget: 5, runs: [{ members: [slot(0.6)] }] };
  budget.checkBudget({ state: { disposed: false }, swarm: under, ctx: fakeCtx });
  assert.equal(under.budgetHit, undefined, "under budget nothing happens");
  budget.checkBudget({ state: { disposed: false }, swarm: { id: "sw3", runs: [{ members: [slot(9)] }] }, ctx: fakeCtx });
  assert.equal(notes.length, 1, "no budget, no check");

  // ---- the reserve: the stop fires below the ceiling, by 5% or five cents, at most half ---
  assert.equal(budgetReserve(20), 1);
  assert.equal(budgetReserve(1), 0.05);
  assert.equal(budgetReserve(0.06), 0.03);
  const atLine = { id: "sw4", budget: 1, runs: [{ members: [slot(0.95)], stopped: true }] };
  budget.checkBudget({ state: { disposed: false }, swarm: atLine, ctx: fakeCtx });
  assert.equal(atLine.budgetHit, true, "the stop fires at the reserve line, not at the ceiling");
  const belowLine = { id: "sw5", budget: 1, runs: [{ members: [slot(0.94)] }] };
  budget.checkBudget({ state: { disposed: false }, swarm: belowLine, ctx: fakeCtx });
  assert.equal(belowLine.budgetHit, undefined);

  // ---- the reserve grows with the members still running ------------------------------
  const live = (cost, turns) => Object.assign(slot(cost), { status: "running", turns, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost } });
  const six = (each) => ({ id: "sw6", budget: 0.75, runs: [{ members: Array.from({ length: 6 }, () => live(each, 70)), stopped: true }] });
  assert.equal(budget.wrapUpReserve(six(0.112)).toFixed(4), "0.0768", "6 running members x 8 turns x $0.0016 a turn in their current sessions");
  const early = six(0.113);
  budget.checkBudget({ state: { disposed: false }, swarm: early, ctx: fakeCtx });
  assert.equal(early.budgetHit, true, "$0.678 spent is inside the scaled reserve, though under the flat $0.70 line");
  assert.match(notes.at(-1), /\$0\.68 of \$0\.75, \$0\.08 held for wrap-up/);
  const roomy = six(0.11);
  budget.checkBudget({ state: { disposed: false }, swarm: roomy, ctx: fakeCtx });
  assert.equal(roomy.budgetHit, undefined);
  const ended = { budget: 0.75, runs: [{ members: Array.from({ length: 6 }, () => Object.assign(live(0.112, 70), { status: "done" })) }] };
  assert.equal(budget.wrapUpReserve(ended), 0.05, "members that have ended need no wrap-up turns");
  assert.equal(budget.wrapUpReserve({ budget: 0.2, runs: [{ members: Array.from({ length: 12 }, () => live(0.01, 2)) }] }), 0.1, "never more than half the budget");
  assert.equal(budget.wrapUpReserve({ runs: [{ members: [live(1, 1)] }] }), 0);

  // ---- admission: a session is funded only by what is left above the reserve ---------
  const swarmAt = (spent, sessionCosts, amount = 1) => ({ budget: amount, runs: [{ members: [slot(spent)], sessionCosts }, { members: [], sessionCosts: [] }] });
  assert.equal(budget.sessionEstimate(swarmAt(0.5, [0.2, 0.4])).toFixed(2), "0.30", "the estimate is the average finished session");
  assert.equal(budget.sessionEstimate(swarmAt(0.5, [0.3, 0])).toFixed(2), "0.30", "a session that cost nothing is not averaged in");
  assert.equal(budget.sessionEstimate(swarmAt(0, undefined)), 0.05, "with no finished session the reserve stands in");
  assert.equal(budget.sessionEstimate({ runs: [{ members: [] }] }), 0);
  assert.equal(budget.budgetShortfall(swarmAt(0.6, [0.3, 0.3])), undefined, "$0.35 above the reserve funds a $0.30 session");
  const short = budget.budgetShortfall(swarmAt(0.7, [0.3, 0.3]));
  assert.equal(short.remaining.toFixed(2), "0.25");
  assert.equal(short.estimate.toFixed(2), "0.30");
  assert.equal(budget.budgetShortfall(swarmAt(0.99, [])).remaining, 0, "the remainder never reads below zero");
  assert.equal(budget.budgetShortfall(swarmAt(0.5, undefined)), undefined, "no finished session: the reserve is the estimate");
  assert.equal(budget.budgetShortfall({ runs: [{ members: [slot(9)], sessionCosts: [1] }] }), undefined, "no budget, no admission check");
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

  await command.handler("2 --until-stop --budget 0.3 budget probe", ctx);
  const run = fs.readdirSync(path.join(hordeDir, "runs")).sort()[0];
  const dir = path.join(hordeDir, "runs", run);
  const reportPath = path.join(dir, "REPORT.md");
  for (let i = 0; i < 100 && !fs.existsSync(reportPath); i++) await wait(200);
  assert.ok(fs.existsSync(reportPath), `the run stopped itself and finalized:\n${notifications.join("\n")}`);

  assert.match(fs.readFileSync(path.join(dir, "TASK.md"), "utf-8"), /^Budget: \$0\.30 \(the run clean-stops when member spend comes within \$0\.05 of it, the reserve kept for wrap-up; the reserve grows when many members are running\)$/m);
  const report = fs.readFileSync(reportPath, "utf-8");
  assert.match(report, /^- outcome: stopped-clean$/m);
  assert.match(fs.readFileSync(path.join(dir, "SUMMARY.md"), "utf-8"), /Run stopped at budget\. Outcome: stopped-clean\./);
  const reported = Number(/\$(\d+\.\d+) cost \(budget \$0\.30, reserve \$0\.05\)/.exec(report)?.[1]);
  assert.ok(reported >= 0.3, `REPORT.md states the ceiling, the reserve and the spend: ${report.split("\n").find((l) => l.startsWith("Usage:"))}`);

  const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(events.find((e) => e.action === "run-start").payload.budget, 0.3);
  assert.equal(events.find((e) => e.action === "run-start").payload.budgetReserve, 0.05);
  const stops = events.filter((e) => e.action === "stop-clean");
  assert.equal(stops.length, 1, "one clean stop was requested");
  assert.equal(stops[0].payload.label, "budget");
  assert.deepEqual(stops[0].payload.members, ["member-1", "member-2"]);
  const end = events.find((e) => e.action === "run-end");
  assert.ok(end.payload.spent >= 0.3, `run-end records the spend: ${JSON.stringify(end.payload)}`);
  assert.equal(end.payload.budget, 0.3);
  assert.equal(end.payload.stopLabel, "stopped at budget");
  const exits = events.filter((e) => e.action === "member-exit");
  assert.equal(exits.length, 2, "the first messages crossed the reserve line, so no continuation was started");
  assert.ok(!events.some((e) => e.action === "member-continue"), "a member under a clean stop is not continued");
  assert.ok(exits.every((e) => Math.abs(e.payload.cost - 0.3) < 1e-9), "member-exit records the session's own cost");
  assert.ok(exits.every((e) => e.payload.cacheRead === 210 && e.payload.cacheWrite === 0), "member-exit records the session's cache reads and writes");
  assert.match(report, /^Usage: \d+ turns, \S+ in \(\S+ cached, \d+% hit\) \/ \S+ out, /m);

  assert.ok(notifications.some((n) => /budget reached \(\$\d+\.\d+ of \$0\.30, \$0\.\d\d held for wrap-up\); stopping/.test(n)), notifications.join("\n"));
  assert.ok(notifications.some((n) => /budget: 2 member\(s\) wrapping up/.test(n)), notifications.join("\n"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.triggerTurn, true, "a budget stop is a clean stop");

  const spawns = () => ["member-1", "member-2"].reduce((n, name) => n + (fs.readFileSync(path.join(dir, `${name}.log`), "utf-8").match(/^\[horde\] spawn:/gm) ?? []).length, 0);
  const before = spawns();
  await wait(1000);
  assert.equal(spawns(), before, "no continuation after the stop");

  // ---- a continuation the remainder cannot pay for is not started -----------------------
  // One member, $0.70: the first session leaves $0.35 above the reserve, enough for a second at
  // the $0.30 average; after it $0.05 is left, so the third is refused and the run ends under
  // the ceiling without a budget stop.
  const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "horde-budget-admit-"));
  await command.handler("1 --until-stop --budget 0.7 admission probe", { ...ctx, cwd: cwd2 });
  const runs2 = path.join(cwd2, ".horde", "runs");
  const dir2 = path.join(runs2, fs.readdirSync(runs2).sort()[0]);
  const eventsOf = () => fs.readFileSync(path.join(dir2, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (let i = 0; i < 100 && !eventsOf().some((e) => e.action === "run-end"); i++) await wait(200);
  const admitted = eventsOf();
  const continues = admitted.filter((e) => e.action === "member-continue");
  assert.equal(continues.length, 2, JSON.stringify(continues.map((e) => e.payload)));
  assert.equal(continues[0].payload.skipped, undefined, "the funded continuation started");
  assert.equal(continues[1].payload.skipped, "budget");
  assert.equal(continues[1].payload.remaining.toFixed(2), "0.05");
  assert.equal(continues[1].payload.estimate.toFixed(2), "0.30");
  assert.equal(admitted.filter((e) => e.action === "member-spawn").length, 2, "no third session was spawned");
  assert.ok(!admitted.some((e) => e.action === "stop-clean"), "the ceiling was never reached, so no budget stop");
  const end2 = admitted.find((e) => e.action === "run-end");
  assert.equal(end2.payload.spent.toFixed(2), "0.60");
  assert.ok(end2.payload.spent <= end2.payload.budget, "the run ends under its ceiling");
  assert.match(fs.readFileSync(path.join(dir2, "SUMMARY.md"), "utf-8"), /Budget: 1 session\(s\) not started \(member-1 \(continuation\)\)\./);
  assert.match(fs.readFileSync(path.join(dir2, "member-1.log"), "utf-8"), /continuation not started: budget \(\$0\.05 left above the reserve, a session averages \$0\.30\)/);

  console.log("PASS: horde-budget-test");
  process.exit(0);
}
