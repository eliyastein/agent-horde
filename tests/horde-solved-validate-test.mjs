// Two-phase solved: a proposal leaves coverage work running, a different member
// validates or contests it, and broad tasks must close current-run ideas.
// Doubles as the hanging fake `pi --mode json` child.
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
        content: [{ type: "text", text: "working" }],
        usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    }) + "\n",
  );
  setInterval(() => {}, 1000);
} else {
  delete process.env.PI_HORDE_MEMBER;
  delete process.env.PI_HORDE_DIR;
  delete process.env.PI_HORDE_NAME;
  delete process.env.PI_HORDE_RUN;
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "2000";
  process.env.PI_HORDE_SOLVED_CONFIRM_MS = "8000";

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

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-solved-"));
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
  const runDirs = () => fs.readdirSync(path.join(hordeDir, "runs")).filter((d) => fs.statSync(path.join(hordeDir, "runs", d)).isDirectory()).sort();
  const runAction = (member, params, runId) => actions.runHordeAction(hordeDir, member, params, runId);

  // ---- validation path ------------------------------------------------------
  await command.handler("2 validate probe", ctx);
  await wait(700);
  const run1 = runDirs()[0];
  const dir1 = path.join(hordeDir, "runs", run1);
  await runAction("member-1", { action: "solved", text: "flag is X" }, run1);
  await wait(3600);
  assert.ok(fs.existsSync(path.join(dir1, ".solved")), "the proposal is on disk");
  assert.ok(!fs.existsSync(path.join(dir1, ".stop-clean")), "the proposal leaves other work available");
  assert.ok(!fs.existsSync(path.join(dir1, "REPORT.md")), "the run is not finalized on a bare proposal");
  const board1 = () => fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf-8");
  assert.match(board1(), /SOLVED proposed by member-1: flag is X\. Another member must validate/, "the parent adopted the proposal");
  // The proposer cannot validate itself; a second member confirms and the run winds down.
  await assert.rejects(runAction("member-1", { action: "confirm-solved", text: "self" }, run1), /proposer cannot validate/);
  await runAction("member-2", { action: "confirm-solved", text: "reproduced live" }, run1);
  await wait(3600);
  assert.match(board1(), /SOLVED validated by member-2; winding down\./, "the parent committed after validation");
  await command.handler("stop-hard", ctx);
  await wait(1200);
  const report1 = fs.readFileSync(path.join(dir1, "REPORT.md"), "utf-8");
  assert.match(report1, /^- outcome: solved$/m, "a validated solve is its own terminal state");
  assert.match(report1, /- solved: member-1 proposed the goal answered \(validated by member-2\): flag is X/);
  assert.ok(fs.existsSync(path.join(dir1, "ANSWER.md")), "the answer is a first-class artifact");
  const answer1 = fs.readFileSync(path.join(dir1, "ANSWER.md"), "utf-8");
  assert.match(answer1, /Status: validated by member-2/);
  assert.match(answer1, /flag is X/);
  assert.ok(!report1.includes("goal reported solved:"), "stopped-member metadata cannot look like proposer identity");

  // ---- contest path ---------------------------------------------------------
  await command.handler("2 contest probe", ctx);
  await wait(700);
  const run2 = runDirs()[1];
  const dir2 = path.join(hordeDir, "runs", run2);
  await runAction("member-1", { action: "solved", text: "premature answer" }, run2);
  await wait(3600);
  assert.ok(fs.existsSync(path.join(dir2, ".solved")), "second run has a proposal");
  await runAction("member-2", { action: "contest-solved", text: "source-only, no live evidence" }, run2);
  await wait(3600);
  assert.ok(!fs.existsSync(path.join(dir2, ".solved")), "a contest clears the proposal");
  assert.ok(!fs.existsSync(path.join(dir2, ".stop-clean")), "a contest clears the pause");
  assert.ok(!fs.existsSync(path.join(dir2, "REPORT.md")), "a contested run keeps running");
  const board2 = fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf-8");
  assert.match(board2, /SOLVED proposal contested by member-2: source-only, no live evidence\. Work continues\./, "the parent recorded the contest");
  await command.handler("stop-hard", ctx);
  await wait(1200);
  const report2 = fs.readFileSync(path.join(dir2, "REPORT.md"), "utf-8");
  assert.match(report2, /^- outcome: solved-contested$/m, "a contested proposal is its own outcome");
  assert.match(report2, /- solved: contested; no validated answer survived the run/);

  // ---- broad-task coverage path -------------------------------------------
  await command.handler("2 review project for security vulnerabilities", ctx);
  await wait(700);
  const run3 = runDirs()[2];
  const dir3 = path.join(hordeDir, "runs", run3);
  const idea = await runAction("member-1", { action: "idea", text: "audit authorization surface" }, run3);
  await runAction("member-1", { action: "claim", id: idea.id }, run3);
  await runAction("member-1", { action: "solved", text: "one valid finding" }, run3);
  await runAction("member-2", { action: "confirm-solved", text: "finding reproduced" }, run3);
  await wait(3600);
  assert.ok(!fs.existsSync(path.join(dir3, ".stop-clean")), "an unresolved audit idea blocks wind-down");
  assert.match(
    fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf-8"),
    /this run still has unresolved coverage.*#\d+/,
  );
  await runAction("member-1", { action: "done", id: idea.id, text: "surface covered" }, run3);
  await wait(3600);
  assert.ok(fs.existsSync(path.join(dir3, ".stop-clean")), "wind-down starts after coverage closes");
  await command.handler("stop-hard", ctx);
  await wait(1200);

  console.log("PASS: horde-solved-validate-test");
  process.exit(0);
}
