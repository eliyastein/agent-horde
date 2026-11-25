// --until-stop: a member whose continuation sessions add nothing is parked, a parked member gets
// a fresh session when another member records a finding, and the run ends as stagnated when
// every member is parked. Doubles as the fake child: a session prints one message and exits 0;
// with PARK_TEST_SLOW set, member-2 stays in its first session for 6s.
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
        content: [{ type: "text", text: "nothing left on the board" }],
        usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    }) + "\n",
  );
  await wait(process.env.PARK_TEST_SLOW === "1" && process.env.PI_HORDE_NAME === "member-2" ? 6000 : 150);
  process.exit(0);
} else {
  for (const key of ["PI_HORDE_MEMBER", "PI_HORDE_DIR", "PI_HORDE_NAME", "PI_HORDE_RUN"]) delete process.env[key];
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "2000";
  process.env.PI_HORDE_CONTINUE_COOLDOWN_MS = "100";
  process.env.PI_HORDE_RESET_CAP = "0";
  process.env.PI_HORDE_PARK_AFTER = "2";
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
  const actions = await jiti.import("../src/tool/actions.ts");
  const park = await jiti.import("../src/run/park.ts");

  // ---- what counts as work ----------------------------------------------------------------
  const ev = (seq, actor, action, attempt = "a1", outcome = "applied") => ({ seq, actor, action, attempt, outcome });
  const log = [ev(1, "member-1", "post"), ev(2, "member-1", "idea"), ev(3, "member-1", "finding", "a1", "rejected"), ev(4, "member-1", "fact", "a0"), ev(5, "member-2", "finding")];
  assert.equal(park.sessionAddedWork(log, "member-1", "a1"), false, "posts, ideas, refused findings and another session's facts are not work");
  assert.equal(park.sessionAddedWork(log, "member-1", "a0"), true, "a fact is work");
  assert.equal(park.sessionAddedWork(log, "member-2", "a1"), true);
  assert.equal(park.workByOthersSince(log, "member-1", 4), true, "a finding by another member unparks");
  assert.equal(park.workByOthersSince(log, "member-1", 5), false, "only work after the park counts");
  assert.equal(park.workByOthersSince(log, "member-2", 0), false, "a fact or one's own finding does not unpark");
  assert.equal(park.workByOthersSince([ev(9, "parent", "finding")], "member-1", 0), false);
  const duplicate = (seq, actor, action) => ({ ...ev(seq, actor, action), payload: { result: { duplicate: true } } });
  assert.equal(park.sessionAddedWork([duplicate(1, "member-1", "fact"), duplicate(2, "member-1", "finding")], "member-1", "a1"), false, "a fact or finding that matched an existing record is not work");
  assert.equal(park.sessionAddedWork([duplicate(1, "member-1", "fact"), ev(2, "member-1", "fact")], "member-1", "a1"), true, "a new fact beside a duplicate is work");
  assert.equal(park.workByOthersSince([duplicate(9, "member-2", "finding")], "member-1", 0), false, "a duplicate finding by another member does not unpark");
  console.log("PASS: horde-park-test check");

  const commands = new Map();
  const pi = { registerTool: () => {}, registerCommand: (n, d) => commands.set(n, d), registerMessageRenderer: () => {}, on: () => {}, sendMessage: () => {} };
  mod.default(pi);
  const ui = { notify: () => {}, setWidget: () => {}, setStatus: () => {} };
  const command = commands.get("agent-horde");
  const start = async (prompt) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-park-"));
    const ctx = { cwd, hasUI: false, ui, model: undefined, thinkingLevel: undefined, isProjectTrusted: () => true };
    await command.handler(prompt, ctx);
    const hordeDir = path.join(cwd, ".horde");
    const runId = fs.readdirSync(path.join(hordeDir, "runs")).sort()[0];
    const dir = path.join(hordeDir, "runs", runId);
    const events = () => fs.readFileSync(path.join(dir, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const until = async (test, label) => {
      for (let i = 0; i < 150 && !test(events()); i++) await wait(100);
      assert.ok(test(events()), `${label}:\n${events().map((e) => `${e.actor} ${e.action}`).join("\n")}`);
    };
    return { ctx, hordeDir, runId, dir, events, until };
  };

  // ---- every member parks: the run ends as stagnated --------------------------------------
  const a = await start("2 --until-stop park probe");
  await a.until((all) => all.some((e) => e.action === "run-end"), "the run ended on its own");
  const parked = a.events().filter((e) => e.action === "member-parked");
  assert.deepEqual(parked.map((e) => e.payload.member).sort(), ["member-1", "member-2"]);
  assert.ok(parked.every((e) => e.payload.reason === "stagnated" && e.payload.emptySessions === 2));
  for (const name of ["member-1", "member-2"]) {
    assert.equal(a.events().filter((e) => e.action === "member-spawn" && e.payload.member === name).length, 3, `${name}: a first session and two continuations`);
    assert.match(fs.readFileSync(path.join(a.dir, `${name}.log`), "utf-8"), /^\[horde\] parked: 2 continuation session\(s\) in a row added nothing$/m);
  }
  assert.equal(a.events().find((e) => e.action === "run-end").payload.outcome, "stagnated");
  assert.ok(!a.events().some((e) => e.action === "stop-clean" || e.action === "stop-hard"), "nobody had to be stopped");
  assert.match(fs.readFileSync(path.join(a.dir, "SUMMARY.md"), "utf-8"), /Run stopped: stagnated \(every member was parked after continuation sessions that added nothing\)\. Outcome: stagnated\./);
  assert.match(fs.readFileSync(path.join(a.hordeDir, "BOARD.md"), "utf-8"), /member-1 is parked: its last 2 sessions added no finding, fact, review or artifact\./);

  // ---- a parked member is unparked by another member's finding ----------------------------
  process.env.PARK_TEST_SLOW = "1";
  const b = await start("2 --until-stop unpark probe");
  await b.until((all) => all.some((e) => e.action === "member-parked" && e.payload.member === "member-1"), "member-1 parked while member-2 was still in its first session");
  await wait(400);
  assert.ok(!b.events().some((e) => e.action === "run-end"), "a member still working keeps the run open");
  const spawnsOf1 = () => b.events().filter((e) => e.action === "member-spawn" && e.payload.member === "member-1").length;
  assert.equal(spawnsOf1(), 3, "a parked member gets no session");
  const act = (params) => actions.runHordeAction(b.hordeDir, "member-2", params, b.runId);
  const idea = await act({ action: "idea", text: "Probe the second host for the same header" });
  await act({ action: "claim", id: idea.id });
  await act({ action: "finding", idea: idea.id, text: "Second host returns the header\nobserved on a live request", concern: "header-leak", concernDef: "Hosts that return the internal header.", support: "tested" });
  await b.until((all) => all.some((e) => e.action === "member-unparked" && e.payload.member === "member-1"), "member-2's finding unparked member-1");
  await b.until(() => spawnsOf1() === 4, "the unparked member got a fresh session");
  await command.handler("stop-hard", b.ctx);
  await b.until((all) => all.some((e) => e.action === "run-end"), "the run finalized after the stop");
  assert.notEqual(b.events().find((e) => e.action === "run-end").payload.outcome, "stagnated");

  console.log("PASS: horde-park-test");
  process.exit(0);
}
