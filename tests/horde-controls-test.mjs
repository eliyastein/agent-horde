// Control commands: pause, resume, stop-hard, stop-clean (with idea release),
// and slash-command argument completion.
// This file doubles as the long-running fake `pi --mode json` child.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

delete process.env.PI_HORDE_MEMBER;
delete process.env.PI_HORDE_DIR;
delete process.env.PI_HORDE_NAME;
delete process.env.PI_HORDE_RUN;
process.env.PI_HORDE_POSTMORTEM = "off";
process.env.PI_HORDE_DELIVERABLE = "off";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv.includes("--mode")) {
  const heartbeat = process.env.HB_FILE;
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  process.stdout.write(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "canary output" }],
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    }) + "\n",
  );
  let beat = 0;
  setInterval(() => {
    try {
      fs.writeFileSync(heartbeat, String(++beat));
    } catch {
      // ignore
    }
  }, 30);
  setInterval(() => {}, 1000);
} else {
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
  const agentHordeExtension = mod.default ?? mod;
  const ledger = {
    ...(await jiti.import("../src/ledger/claims.ts")),
    ...(await jiti.import("../src/ledger/ideas.ts")),
    ...(await jiti.import("../src/ledger/run-signals.ts")),
  };

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-controls-"));
  const heartbeatFile = path.join(cwd, "heartbeat");
  process.env.HB_FILE = heartbeatFile;
  const hordeDir = path.join(cwd, ".horde");
  const beats = () =>
    fs.existsSync(heartbeatFile) ? Number(fs.readFileSync(heartbeatFile, "utf-8")) : 0;

  const commands = new Map();
  const notifications = [];
  const sent = [];
  const pi = {
    registerTool: () => {},
    registerCommand: (name, def) => commands.set(name, def),
    registerMessageRenderer: () => {},
    on: () => {},
    sendMessage: (msg, opts) => sent.push({ msg, opts }),
  };
  agentHordeExtension(pi);
  const ui = {
    notify: (text, level) => notifications.push(`${level}: ${text}`),
    setWidget: () => {},
    setStatus: () => {},
  };
  const ctx = { cwd, hasUI: false, ui, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");
  assert.ok(command, "agent-horde command registered");

  const runDirs = () =>
    fs
      .readdirSync(path.join(hordeDir, "runs"))
      .filter((d) => fs.statSync(path.join(hordeDir, "runs", d)).isDirectory())
      .sort();

  // ---- run 1: pause, resume, stop-hard -------------------------------------
  await command.handler("1 pause probe", ctx);
  await wait(300);
  assert.ok(beats() > 0, "fake child should be producing heartbeats");

  await command.handler("pause member-1", ctx);
  const frozen = beats();
  await wait(300);
  assert.equal(beats(), frozen, "SIGSTOP should freeze the child");
  assert.ok(notifications.some((n) => /paused 1 member/.test(n)));

  await command.handler("resume member-1", ctx);
  await wait(300);
  assert.ok(beats() > frozen, "SIGCONT should resume the child");
  assert.ok(notifications.some((n) => /resumed 1 member/.test(n)));

  await command.handler("pause member-9", ctx);
  assert.ok(notifications.some((n) => /no such member: member-9/.test(n)));

  await command.handler("status", ctx);
  assert.ok(notifications.some((n) => /^info: horde \d{8}-\d{6}/m.test(n)));

  await command.handler("stop-hard", ctx);
  await wait(600);
  assert.ok(notifications.some((n) => /stop-hard: terminating member-1/.test(n)));
  assert.equal(sent.length, 1, "stop-hard should produce one report");
  assert.equal(sent[0].opts.triggerTurn, false, "a hard stop must not trigger a parent turn");
  assert.ok(runDirs().every((d) => fs.existsSync(path.join(hordeDir, "runs", d, "SUMMARY.md"))));
  const report1 = fs.readFileSync(path.join(hordeDir, "runs", runDirs()[0], "REPORT.md"), "utf-8");
  assert.match(report1, /## Diagnosis/);
  assert.match(report1, /outcome: stopped-hard/);
  assert.match(report1, /stopped by user: member-1/);
  assert.match(report1, /distinct clusters/);

  // ---- run 2: stop-clean releases claimed ideas ----------------------------
  await command.handler("1 clean probe", ctx);
  await wait(300);
  const runId = runDirs()[runDirs().length - 1];
  const runDir = path.join(hordeDir, "runs", runId);

  const claimed = await ledger.addIdea(hordeDir, "member-1", "clean stop claim probe");
  await ledger.claimIdea(hordeDir, "member-1", claimed.idea.id);
  await ledger.assertClaim(hordeDir, "member-1", "test hypothesis for the run report");

  // Argument completion sees the live run's members.
  const subs = command.getArgumentCompletions("");
  assert.ok(subs.some((i) => i.value === "stop-hard "), "completes stop-hard");
  assert.ok(subs.some((i) => i.value === "stop-clean "), "completes stop-clean");
  const filtered = command.getArgumentCompletions("stop-");
  assert.deepEqual(filtered.map((i) => i.label).sort(), ["stop-clean", "stop-hard"]);
  const targets = command.getArgumentCompletions("pause ");
  assert.ok(targets.some((i) => i.value === "pause all"));
  assert.ok(targets.some((i) => i.value === "pause member-1"));

  // stop-clean completion advertises the postmortem option and --grace.
  const clean = command.getArgumentCompletions("stop-clean ");
  assert.ok(clean.some((i) => i.value === "stop-clean postmortem "), "offers postmortem");
  assert.ok(clean.some((i) => i.value === "stop-clean --grace=60"), "offers --grace");
  assert.ok(clean.some((i) => i.value === "stop-clean all"), "still offers targets");
  const afterPost = command.getArgumentCompletions("stop-clean postmortem ");
  assert.ok(!afterPost.some((i) => i.value === "stop-clean postmortem postmortem "));
  assert.ok(afterPost.some((i) => i.value === "stop-clean postmortem all"));
  assert.deepEqual(
    command.getArgumentCompletions("stop-clean --g").map((i) => i.label),
    ["--grace=60"],
  );

  await command.handler("stop-clean", ctx);
  const request = ledger.readCleanStop(runDir);
  assert.ok(request, "stop-clean writes a sentinel");
  assert.equal(request.runId, runId);
  assert.deepEqual(request.members, [], "all members are covered");

  // New work is refused during the clean-stop window, wrap-up actions still work.
  const refused = await actions.runHordeAction(
    hordeDir,
    "member-1",
    { action: "idea", text: "should not be added" },
    runId,
  );
  assert.match(refused.text, /clean stop was requested/i);
  const listed = await actions.runHordeAction(hordeDir, "member-1", { action: "list" }, runId);
  assert.match(listed.text, /clean stop claim probe/);

  // The fake child never wraps up, so escalate; finalize must still release ideas.
  await command.handler("stop-hard", ctx);
  await wait(700);
  const released = ledger.listIdeas(hordeDir).find((i) => i.id === claimed.idea.id);
  assert.equal(released.mark, " ", "stop-clean should return the idea to the open pool");
  assert.equal(released.owner, undefined);
  assert.ok(!fs.existsSync(path.join(runDir, ".stop-clean")), "sentinel is cleared at finalize");
  const boardText = fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf-8");
  assert.match(boardText, /finalize: closed none; released #\d+/);
  assert.equal(sent.length, 2, "the clean stop should produce a second report");
  assert.equal(sent[1].opts.triggerTurn, true, "a clean stop should trigger synthesis");
  const report2 = fs.readFileSync(path.join(runDir, "REPORT.md"), "utf-8");
  assert.match(report2, /outcome: stopped-clean/);
  assert.match(report2, /## Claims/);
  assert.match(report2, /\[unverified\] C1/);
  assert.match(report2, /canary: ok/);
  assert.equal(actions.runHordeAction.length >= 3, true);

  console.log("PASS: horde-controls-test");
}
