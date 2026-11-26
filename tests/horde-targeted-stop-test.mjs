// A stop that names some members leaves the run working for the rest: the budget still stops
// it, `tell` still reaches them, `--until-stop` still continues them, and the run's outcome is
// its own. Doubles as the fake child: member-1 idles until it is killed; every other member
// reports thirty one-cent messages after SPEND_AFTER_MS and exits 0.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--mode")) {
  const say = (cost) =>
    process.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "working" }],
          usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
          stopReason: "stop",
        },
      }) + "\n",
    );
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  say(0);
  if (process.env.PI_HORDE_NAME === "member-1") {
    setInterval(() => {}, 1000);
  } else {
    await wait(Number(process.env.SPEND_AFTER_MS));
    for (let turn = 0; turn < 30; turn++) say(0.01);
    await wait(300);
    process.exit(0);
  }
} else {
  delete process.env.PI_HORDE_MEMBER;
  delete process.env.PI_HORDE_DIR;
  delete process.env.PI_HORDE_NAME;
  delete process.env.PI_HORDE_RUN;
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "2000";
  process.env.PI_HORDE_CONTINUE_COOLDOWN_MS = "200";
  process.env.PI_HORDE_ACTIVE_GRACE_MS = "1";
  process.env.PI_HORDE_PARK_POLL_MS = "100";

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

  /** Launch a run in a fresh directory and return what the assertions read. */
  const launch = async (args) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-targeted-stop-"));
    const hordeDir = path.join(cwd, ".horde");
    const commands = new Map();
    const notifications = [];
    const pi = { registerTool: () => {}, registerCommand: (n, d) => commands.set(n, d), registerMessageRenderer: () => {}, on: () => {}, sendMessage: () => {} };
    mod.default(pi);
    const ui = { notify: (t, l) => notifications.push(`${l}: ${t}`), setWidget: () => {}, setStatus: () => {} };
    const ctx = { cwd, hasUI: false, ui, model: undefined, thinkingLevel: undefined, isProjectTrusted: () => true };
    const command = (text) => commands.get("agent-horde").handler(text, ctx);
    await command(args);
    const dir = path.join(hordeDir, "runs", fs.readdirSync(path.join(hordeDir, "runs")).sort()[0]);
    const events = () => fs.readFileSync(path.join(dir, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const until = async (done, what) => {
      for (let i = 0; i < 150 && !done(); i++) await wait(100);
      assert.ok(done(), `${what}:\n${notifications.join("\n")}`);
    };
    return { command, dir, events, until, notifications };
  };
  const spawned = (run, name) => run.events().some((e) => e.action === "member-spawn" && e.payload.member === name);
  const finished = (run) => fs.existsSync(path.join(run.dir, "REPORT.md"));

  // ---- the budget still stops the run after one member was stopped -----------------------
  process.env.SPEND_AFTER_MS = "2500";
  const budgeted = await launch("2 --budget 0.3 targeted stop probe");
  await budgeted.until(() => spawned(budgeted, "member-2"), "both members started");
  await budgeted.command("stop-clean member-1 --grace 1");
  await budgeted.command("tell member-2 keep going");
  assert.ok(budgeted.notifications.some((n) => /O\d+ sent to member-2/.test(n)), `tell reaches the member that was not stopped:\n${budgeted.notifications.join("\n")}`);
  await budgeted.until(() => finished(budgeted), "the run stopped itself at the budget");

  const stops = budgeted.events().filter((e) => e.action === "stop-clean");
  assert.deepEqual(stops.map((e) => e.payload.label), ["stop-clean", "budget"], "the user's stop of one member, then the budget stop");
  assert.deepEqual(stops[0].payload.members, ["member-1"]);
  assert.equal(stops[0].payload.all, false);
  const budgetEnd = budgeted.events().find((e) => e.action === "run-end").payload;
  assert.equal(budgetEnd.stopLabel, "stopped at budget", "the run is labelled by the stop that ended it");
  assert.equal(budgetEnd.outcome, "stopped-clean");
  assert.ok(!budgeted.events().some((e) => e.action === "member-reset"), "a member stopped by the user is not reset");
  assert.match(fs.readFileSync(path.join(budgeted.dir, "REPORT.md"), "utf-8"), /stopped by user: member-1/, "the report names the member the user stopped");
  console.log("PASS: horde-targeted-stop-test budget");

  // ---- a stopped member that exits inside the grace period ends the stop --------------------
  process.env.SPEND_AFTER_MS = "400";
  const early = await launch("2 targeted stop probe");
  await early.until(() => spawned(early, "member-2"), "both members started");
  await early.command("stop-clean member-2 --grace 2");
  await early.until(() => early.events().some((e) => e.action === "member-exit" && e.payload.member === "member-2"), "member-2 exited on its own");
  early.notifications.length = 0;
  await early.command("status");
  assert.ok(!early.notifications.some((n) => /hard stop in/.test(n)), `the run is not shown as stopping once the stopped member is down:\n${early.notifications.join("\n")}`);
  await wait(2500);
  assert.ok(!early.events().some((e) => e.action === "stop-hard"), "no stop-hard is recorded for a member that had already exited");
  await early.command("stop-hard");
  await early.until(() => finished(early), "the run ended on the hard stop");
  assert.deepEqual(early.events().filter((e) => e.action === "stop-hard").map((e) => e.payload.by), ["user"]);
  console.log("PASS: horde-targeted-stop-test early exit");

  // ---- --until-stop still continues the others, and the run ends on its own terms ----------
  process.env.SPEND_AFTER_MS = "300";
  const open = await launch("2 --until-stop targeted stop probe");
  await open.until(() => spawned(open, "member-2"), "both members started");
  await open.command("stop-clean member-1 --grace 1");
  await open.until(() => finished(open), "the run ended once member-2 was parked");

  const continued = open.events().filter((e) => e.action === "member-continue").map((e) => e.payload.member);
  assert.ok(continued.length >= 3 && continued.every((name) => name === "member-2"), `only member-2 is continued: ${continued.join(", ")}`);
  assert.ok(open.events().some((e) => e.action === "member-parked" && e.payload.member === "member-2"));
  const openEnd = open.events().find((e) => e.action === "run-end").payload;
  assert.equal(openEnd.outcome, "stagnated", "a stop of one member does not make the run a stopped run");
  assert.equal(openEnd.stopLabel, undefined);
  console.log("PASS: horde-targeted-stop-test");
  process.exit(0);
}
