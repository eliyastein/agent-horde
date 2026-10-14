// Post-mortem generation: automatic on organic completion, and on
// `stop-clean postmortem` even though that is a user stop.
// This file doubles as the fake `pi --mode json` member child.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

delete process.env.PI_HORDE_MEMBER;
delete process.env.PI_HORDE_DIR;
delete process.env.PI_HORDE_NAME;
delete process.env.PI_HORDE_RUN;
delete process.env.PI_HORDE_POSTMORTEM;
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const POSTMORTEM = "# Verdict\n\nThe run was fine but duplicated work.";

if (process.argv.includes("-p") && !process.argv.includes("--mode")) {
  // Fake one-shot helper (post-mortem / deliverable): log the call, print the report.
  fs.appendFileSync(process.env.HORDE_HELPER_LOG, JSON.stringify({ args: process.argv.slice(2), parent: process.env.PI_HORDE_PARENT_PID }) + "\n");
  process.stdout.write(POSTMORTEM);
} else if (process.argv.includes("--mode")) {
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  process.stdout.write(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "member finished" }],
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    }) + "\n",
  );
  if (process.env.EXIT_AFTER === "1") setTimeout(() => process.exit(0), 150);
  else setInterval(() => {}, 1000);
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
  const { default: agentHordeExtension } = await jiti.import(
    "../src/index.ts",
  );
  const actions = await jiti.import("../src/tool/actions.ts");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm-"));
  const hordeDir = path.join(cwd, ".horde");
  const commands = new Map();
  const sent = [];
  const renderers = new Map();
  process.env.HORDE_HELPER_LOG = path.join(cwd, "helper-calls.log");
  const execCalls = () =>
    fs.existsSync(process.env.HORDE_HELPER_LOG)
      ? fs.readFileSync(process.env.HORDE_HELPER_LOG, "utf-8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
  const pi = {
    registerTool: () => {},
    registerCommand: (name, def) => commands.set(name, def),
    registerMessageRenderer: (type, fn) => renderers.set(type, fn),
    on: () => {},
    sendMessage: (msg, opts) => sent.push({ msg, opts }),
  };
  agentHordeExtension(pi);
  const ui = { notify: () => {}, setWidget: () => {}, setStatus: () => {} };
  const ctx = { cwd, hasUI: false, ui, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");
  const runDirs = () =>
    fs
      .readdirSync(path.join(hordeDir, "runs"))
      .filter((d) => fs.statSync(path.join(hordeDir, "runs", d)).isDirectory())
      .sort();

  // Run 1: organic completion runs the post-mortem automatically.
  process.env.EXIT_AFTER = "1";
  await command.handler("1 organic run", ctx);
  await wait(2500);
  const run1 = runDirs()[runDirs().length - 1];
  assert.ok(
    fs.existsSync(path.join(hordeDir, "runs", run1, "POSTMORTEM.md")),
    "POSTMORTEM.md should be written on organic completion",
  );
  assert.match(
    fs.readFileSync(path.join(hordeDir, "runs", run1, "REPORT.md"), "utf-8"),
    /## Post-mortem/,
  );
  assert.match(sent[0].msg.content, /## Post-mortem/);
  assert.ok(
    fs.existsSync(path.join(hordeDir, "runs", run1, "DELIVERABLE.md")),
    "DELIVERABLE.md should be written on organic completion",
  );
  assert.ok(sent[0].msg.content.includes("## Deliverable"));
  assert.ok(execCalls().length >= 1, "post-mortem agent should be spawned");
  assert.ok(execCalls()[0].args.includes("--append-system-prompt"));
  assert.equal(execCalls()[0].parent, String(process.pid), "helper carries the parent pid");
  // The report renderer must display the post-mortem, not just the member table.
  const renderer = renderers.get("agent-horde-report");
  const theme = { fg: (_c, s) => s, bold: (s) => s };
  const rendered = renderer({ details: sent[0].msg.details }, { outputPad: 0 }, theme)
    .render(120)
    .join("\n");
  assert.match(rendered, /post-mortem/);
  assert.match(rendered, /Verdict/);
  assert.match(rendered, /deliverable/);

  // Run 2: plain stop-clean must NOT run a post-mortem.
  process.env.EXIT_AFTER = "0";
  await command.handler("1 plain clean run", ctx);
  await wait(400);
  await command.handler("stop-clean", ctx);
  await command.handler("stop-hard", ctx);
  await wait(1200);
  const run2 = runDirs()[runDirs().length - 1];
  assert.ok(
    !fs.existsSync(path.join(hordeDir, "runs", run2, "POSTMORTEM.md")),
    "plain stop-clean should not run a post-mortem",
  );

  // Run 3: stop-clean postmortem runs it despite the user stop.
  await command.handler("1 audited clean run", ctx);
  await wait(400);
  await command.handler("stop-clean postmortem", ctx);
  await command.handler("stop-hard", ctx);
  await wait(1200);
  const run3 = runDirs()[runDirs().length - 1];
  assert.ok(
    fs.existsSync(path.join(hordeDir, "runs", run3, "POSTMORTEM.md")),
    "stop-clean postmortem should write POSTMORTEM.md",
  );
  assert.match(fs.readFileSync(path.join(hordeDir, "runs", run3, "REPORT.md"), "utf-8"), /## Post-mortem/);

  // Run 4: a solved run is an early success, so the post-mortem still runs.
  process.env.EXIT_AFTER = "0";
  await command.handler("1 solved run", ctx);
  await wait(400);
  const run4 = runDirs()[runDirs().length - 1];
  await actions.runHordeAction(hordeDir, "member-1", { action: "solved", text: "goal answered" }, run4);
  await wait(3600); // let the parent poll pick up .solved and clean-stop
  await command.handler("stop-hard", ctx);
  await wait(1500);
  assert.ok(
    fs.existsSync(path.join(hordeDir, "runs", run4, "POSTMORTEM.md")),
    "a solved run should still write POSTMORTEM.md",
  );

  console.log("PASS: horde-postmortem-test");
}
