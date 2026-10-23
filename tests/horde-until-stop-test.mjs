// --until-stop: a member that finishes its session is given a fresh one, a validated solve is
// banked and the proposal slot reopens instead of the run winding down, and stop-clean still
// finalizes with the banked answer standing over an unvalidated re-proposal. Doubles as the
// fake child: every session prints one message and exits 0.
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
  const actions = await jiti.import("../src/tool/actions.ts");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-until-stop-"));
  const hordeDir = path.join(cwd, ".horde");
  const commands = new Map();
  const notifications = [];
  const pi = {
    registerTool: () => {},
    registerCommand: (n, d) => commands.set(n, d),
    registerMessageRenderer: () => {},
    on: () => {},
    sendMessage: () => {},
  };
  mod.default(pi);
  const ui = { notify: (t, l) => notifications.push(`${l}: ${t}`), setWidget: () => {}, setStatus: () => {} };
  const ctx = { cwd, hasUI: false, ui, model: undefined, thinkingLevel: undefined, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");
  const runAction = (member, params, runId) => actions.runHordeAction(hordeDir, member, params, runId);
  const runDirs = () => fs.readdirSync(path.join(hordeDir, "runs")).sort();
  const log = (dir, name) => fs.readFileSync(path.join(dir, `${name}.log`), "utf-8");
  const spawns = (text) => (text.match(/^\[horde\] spawn:/gm) ?? []).length;
  const board = () => fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf-8");

  // ---- finished members continue in fresh sessions ----------------------------
  await command.handler("2 --until-stop continue probe", ctx);
  await wait(3500);
  const run = runDirs()[0];
  const dir = path.join(hordeDir, "runs", run);
  for (const name of ["member-1", "member-2"]) {
    const text = log(dir, name);
    assert.ok(spawns(text) >= 2, `${name} was given a fresh session:\n${text}`);
    assert.match(text, /^\[horde\] continue 1: until-stop: earlier session finished$/m);
    assert.doesNotMatch(text, /^\[horde\] reset /m, "a continuation is not a reset");
    const lines = text.split("\n").filter((l) => l.startsWith("[horde] spawn:"));
    assert.match(lines[0], /This run continues until the user stops it\. When nothing worthwhile remains/);
    assert.doesNotMatch(lines[0], /fresh session of/);
    assert.match(lines[1], new RegExp(`You are a fresh session of ${name}; its earlier session finished`));
  }
  assert.match(board(), /member-1 finished and continues in a fresh session/);
  assert.match(fs.readFileSync(path.join(dir, "TASK.md"), "utf-8"), /^Until stop: yes/m, "TASK.md records the flag");
  const runStart = fs.readFileSync(path.join(dir, "events.jsonl"), "utf-8").split("\n").map((l) => l && JSON.parse(l)).find((e) => e && e.action === "run-start");
  assert.equal(runStart.payload.untilStop, true, "the run-start event records the flag");
  assert.ok(!fs.existsSync(path.join(dir, "REPORT.md")), "the run did not finalize when every member finished");

  // ---- a validated solve is banked and the slot reopens -----------------------
  await runAction("member-1", { action: "solved", text: "flag is X" }, run);
  await runAction("member-2", { action: "confirm-solved", text: "reproduced live" }, run);
  await wait(3600);
  assert.ok(!fs.existsSync(path.join(dir, ".solved")), "the banked proposal is cleared");
  assert.ok(!fs.existsSync(path.join(dir, ".stop-clean")), "a banked solve stops nobody");
  assert.match(board(), /SOLVED validated by member-2, banked as round 1: flag is X\. This run continues until the user stops it\./);
  const banked = fs.readFileSync(path.join(dir, "ANSWER.md"), "utf-8");
  assert.match(banked, /Status: validated by member-2 \(banked as round 1; the run continues until stopped\)/);
  assert.ok(fs.readdirSync(path.join(dir, "answers")).length >= 1, "the banked signal is archived");
  const second = await runAction("member-1", { action: "solved", text: "flag is Y" }, run);
  assert.ok(fs.existsSync(path.join(dir, ".solved")), `a new proposal is accepted after banking: ${JSON.stringify(second)}`);
  await wait(700);
  assert.ok(!fs.existsSync(path.join(dir, "REPORT.md")), "still running");

  // ---- stop-clean winds down with the banked answer standing ------------------
  const before = spawns(log(dir, "member-1")) + spawns(log(dir, "member-2"));
  await command.handler("stop-clean", ctx);
  await wait(3000);
  assert.ok(fs.existsSync(path.join(dir, "REPORT.md")), `stop-clean finalized the run:\n${notifications.join("\n")}`);
  const after = spawns(log(dir, "member-1")) + spawns(log(dir, "member-2"));
  assert.ok(after <= before + 2, `no continuation after the stop (${before} -> ${after})`);
  const answer = fs.readFileSync(path.join(dir, "ANSWER.md"), "utf-8");
  assert.match(answer, /Status: validated by member-2/);
  assert.match(answer, /flag is X/, "the banked answer beats the unvalidated re-proposal");
  assert.doesNotMatch(answer, /flag is Y/);
  const report = fs.readFileSync(path.join(dir, "REPORT.md"), "utf-8");
  assert.match(report, /validated by member-2.*flag is X/);
  assert.doesNotMatch(report, /^## Resets$/m, "continuations are not resets");

  console.log("PASS: horde-until-stop-test");
  process.exit(0);
}
