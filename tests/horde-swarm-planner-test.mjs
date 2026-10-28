// A plain `2/1 <prompt>` is partitioned by the planner helper before launch; each horde gets its
// slice as the workstream every member sees. A planner that cannot produce H distinct workstreams
// stops the launch with that message and leaves the slot free. Doubles as the fake pi: the planner
// invocation prints JSON (good or bad, per PLANNER_MODE), a member session prints one message.
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
        content: [{ type: "text", text: "slice done" }],
        usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    }) + "\n",
  );
  await wait(200);
  process.exit(0);
} else if (process.argv.includes("-p")) {
  // The planner helper (read-only pi -p). PLANNER_MODE picks the shape of its answer.
  const systemPrompt = process.argv[process.argv.indexOf("--append-system-prompt") + 1] ?? "";
  if (!/planner for a swarm/.test(systemPrompt)) {
    process.stdout.write("unexpected helper\n");
    process.exit(1);
  }
  const task = process.argv[process.argv.length - 1];
  const mode = process.env.PLANNER_MODE ?? "good";
  if (mode === "good") {
    assert.match(task, /exactly 2 disjoint workstreams/);
    assert.match(task, /Task:\n\nreview the parser and the emitter/);
    process.stdout.write('Here is the split:\n[{"workstream": "Review the parser", "acceptance": "every parser path has a verdict"}, {"workstream": "Review the emitter", "acceptance": "every emitter path has a verdict"}]\n');
  } else if (mode === "one") {
    process.stdout.write('[{"workstream": "Review everything", "acceptance": "done"}]\n');
  } else {
    process.stdout.write("I cannot split this task.\n");
  }
  process.exit(0);
} else {
  delete process.env.PI_HORDE_MEMBER;
  delete process.env.PI_HORDE_DIR;
  delete process.env.PI_HORDE_NAME;
  delete process.env.PI_HORDE_RUN;
  delete process.env.PI_HORDE_SIBLINGS;
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "2000";
  process.env.PI_HORDE_SWARM_STAGGER_MS = "100";
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

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-swarm-planner-"));
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
  const swarmsDir = path.join(hordeDir, "swarms");
  const since = (from) => notifications.slice(from);

  // ---- a planner that cannot split stops the launch ----------------------------
  process.env.PLANNER_MODE = "one";
  await command.handler("2/1 review the parser and the emitter", ctx);
  const failedId = fs.readdirSync(swarmsDir)[0];
  assert.ok(notifications.some((n) => n.startsWith(`info: swarm ${failedId}: planner is partitioning the task into 2 workstreams`)), notifications.join("\n"));
  assert.ok(notifications.some((n) => n === `error: swarm ${failedId} not started: the planner produced 1 workstream(s), not 2`), notifications.join("\n"));
  assert.match(fs.readFileSync(path.join(swarmsDir, failedId, "SWARM.md"), "utf-8"), /^Not started: the planner produced 1 workstream\(s\), not 2$/m);
  assert.ok(!fs.existsSync(path.join(swarmsDir, failedId, "h1", "runs", `${failedId}-h1`, "TASK.md")), "no horde was started");
  let mark = notifications.length;
  await command.handler("status", ctx);
  assert.ok(since(mark).some((n) => n === "info: no horde run is active"), "the slot stays free after a failed partition");

  process.env.PLANNER_MODE = "prose";
  mark = notifications.length;
  await command.handler("2/1 review the parser and the emitter", ctx);
  assert.ok(since(mark).some((n) => /not started: the planner printed no JSON array/.test(n)), since(mark).join("\n"));

  // ---- a good partition launches one horde per slice ---------------------------
  process.env.PLANNER_MODE = "good";
  mark = notifications.length;
  await command.handler("2/1 review the parser and the emitter", ctx);
  const swarmId = fs.readdirSync(swarmsDir).sort().at(-1);
  assert.ok(since(mark).some((n) => n.startsWith(`info: swarm ${swarmId} started: 2 hordes of 1 members`)), since(mark).join("\n"));
  assert.ok(since(mark).some((n) => n === "info: h1: Review the parser Acceptance: every parser path has a verdict"), since(mark).join("\n"));
  assert.ok(since(mark).some((n) => n === "info: h2: Review the emitter Acceptance: every emitter path has a verdict"));
  const swarmDir = path.join(swarmsDir, swarmId);
  const swarmMd = fs.readFileSync(path.join(swarmDir, "SWARM.md"), "utf-8");
  assert.match(swarmMd, /^Partition: planner helper$/m);
  assert.match(swarmMd, /^- h1: Review the parser Acceptance: every parser path has a verdict$/m);
  assert.match(swarmMd, /^- h2: Review the emitter Acceptance: every emitter path has a verdict$/m);
  assert.ok(fs.existsSync(path.join(swarmDir, "planner-sessions")), "the planner has its own session directory");
  const runDirs = ["h1", "h2"].map((label) => path.join(swarmDir, label, "runs", `${swarmId}-${label}`));
  assert.match(fs.readFileSync(path.join(runDirs[1], "TASK.md"), "utf-8"), /^Workstream: Review the emitter Acceptance: every emitter path has a verdict$/m);
  assert.ok(!fs.existsSync(path.join(runDirs[0], "PLAN.md")), "a planner slice seeds no plan ideas; members organise within the slice");

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !fs.existsSync(path.join(swarmDir, "REPORT.md"))) await wait(200);
  assert.ok(fs.existsSync(path.join(swarmDir, "REPORT.md")), `the swarm finalized on its own:\n${since(mark).join("\n")}`);
  for (const [i, runDir] of runDirs.entries()) {
    const log = fs.readFileSync(path.join(runDir, "member-1.log"), "utf-8");
    assert.match(log, new RegExp(`Your horde is h${i + 1} of 2 hordes working the same task in parallel`));
    assert.match(log, i === 0 ? /owns workstream 1: \\"Review the parser Acceptance/ : /owns workstream 2: \\"Review the emitter Acceptance/);
    assert.match(fs.readFileSync(path.join(runDir, "REPORT.md"), "utf-8"), /- outcome: completed/);
  }
  const report = fs.readFileSync(path.join(swarmDir, "REPORT.md"), "utf-8");
  assert.match(report, /^- outcomes: h1 completed, h2 completed$/m);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg.customType, "agent-horde-swarm-report");
  assert.equal(sent[0].opts.triggerTurn, true, "a swarm that finished on its own asks the parent to synthesize");

  console.log("PASS: horde-swarm-planner-test");
  process.exit(0);
}
