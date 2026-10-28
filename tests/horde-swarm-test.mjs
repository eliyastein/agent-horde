// Horde of hordes: `plan 2/2 a; b; c; d --until-stop` launches two hordes of two members, each
// with its own ledgers under .horde/swarms/<id>/hN/, deals the layers round-robin, tells every
// member its horde's workstream and its siblings, resolves horde-prefixed control targets,
// unions sibling facts/resources/closed ideas into the read actions, and finalizes the swarm with
// one merged report once every horde is done. Doubles as the fake child: every member session
// records its environment, prints one message and exits 0.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--mode")) {
  const envFile = path.join(process.env.PI_HORDE_DIR, "runs", process.env.PI_HORDE_RUN, `${process.env.PI_HORDE_NAME}.env.json`);
  fs.writeFileSync(envFile, JSON.stringify({ siblings: process.env.PI_HORDE_SIBLINGS ?? "", role: process.env.PI_HORDE_ROLE ?? "" }));
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  process.stdout.write(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done with my slice" }],
        usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
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
  delete process.env.PI_HORDE_SIBLINGS;
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "2000";
  process.env.PI_HORDE_CONTINUE_COOLDOWN_MS = "200";
  process.env.PI_HORDE_SWARM_STAGGER_MS = "200";
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
  const signals = await jiti.import("../src/ledger/run-signals.ts");
  const swarmMod = await jiti.import("../src/run/swarm.ts");

  // ---- pure helpers ----------------------------------------------------------
  assert.deepEqual(swarmMod.dealLayers(["a", "b", "c", "d", "e"], 2), [["a", "c", "e"], ["b", "d"]]);
  assert.deepEqual(swarmMod.dealLayers(["a", "b"], 3), [["a"], ["b"], []]);
  assert.deepEqual(swarmMod.parsePlannerOutput('noise [{"workstream":"A","acceptance":"a ok"},{"workstream":"B"}] tail', 2), {
    slices: ["A Acceptance: a ok", "B"],
  });
  assert.match(swarmMod.parsePlannerOutput('[{"workstream":"A"}]', 2).error, /1 workstream\(s\), not 2/);
  assert.match(swarmMod.parsePlannerOutput('[{"workstream":"A"},{"workstream":" a "}]', 2).error, /repeated a workstream/);
  assert.match(swarmMod.parsePlannerOutput("no json here", 2).error, /no JSON array/);
  assert.match(swarmMod.parsePlannerOutput('[{"workstream":""},{"workstream":"B"}]', 2).error, /empty workstream/);
  console.log("PASS: horde-swarm-test helpers");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-swarm-"));
  const hordeDir = path.join(cwd, ".horde");
  const commands = new Map();
  const notifications = [];
  const sent = [];
  const widgets = [];
  const pi = {
    registerTool: () => {},
    registerCommand: (n, d) => commands.set(n, d),
    registerMessageRenderer: () => {},
    on: () => {},
    sendMessage: (msg, opts) => sent.push({ msg, opts }),
  };
  mod.default(pi);
  const ui = {
    notify: (t, l) => notifications.push(`${l}: ${t}`),
    setWidget: (_key, factory) => { if (factory) widgets.push(factory({ requestRender: () => {} }, { fg: (_c, s) => s, bold: (s) => s })); },
    setStatus: () => {},
  };
  const ctx = { cwd, hasUI: true, ui, model: undefined, thinkingLevel: undefined, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");
  const spawns = (text) => (text.match(/^\[horde\] spawn:/gm) ?? []).length;
  const since = (from) => notifications.slice(from);

  // ---- launch: layout, partition, identity, siblings ----------------------------
  await command.handler("plan 2/2 --until-stop alpha; beta; gamma; delta", ctx);
  const swarmsDir = path.join(hordeDir, "swarms");
  const swarmId = fs.readdirSync(swarmsDir)[0];
  assert.ok(swarmId, `a swarm directory was created:\n${notifications.join("\n")}`);
  const swarmDir = path.join(swarmsDir, swarmId);
  assert.match(fs.readFileSync(path.join(hordeDir, ".gitignore"), "utf-8"), /^swarms\/$/m);
  assert.ok(notifications.some((n) => n.startsWith(`info: swarm ${swarmId} started: 2 hordes of 2 members`)), notifications.join("\n"));
  const hordeDirs = ["h1", "h2"].map((label) => path.join(swarmDir, label));
  const runIds = ["h1", "h2"].map((label) => `${swarmId}-${label}`);
  const runDirs = hordeDirs.map((dir, i) => path.join(dir, "runs", runIds[i]));
  for (const dir of hordeDirs) {
    for (const ledger of ["IDEAS.md", "BOARD.md", "FINDINGS.md", "FACTS.md", "CLAIMS.md", "RESOURCES.md", "CONCERNS.md"]) {
      assert.ok(fs.existsSync(path.join(dir, ledger)), `${dir} has ${ledger}`);
    }
  }
  const swarmMd = fs.readFileSync(path.join(swarmDir, "SWARM.md"), "utf-8");
  assert.match(swarmMd, /^Hordes: 2 x 2 members \(h1 \.\. h2\)$/m);
  assert.match(swarmMd, /^- h1: alpha; gamma$/m, "layers are dealt round-robin");
  assert.match(swarmMd, /^- h2: beta; delta$/m);
  assert.match(swarmMd, /^Until stop: yes/m);
  const task1 = fs.readFileSync(path.join(runDirs[0], "TASK.md"), "utf-8");
  assert.match(task1, new RegExp(`^Swarm: ${swarmId} \\(horde h1 of 2\\)$`, "m"));
  assert.match(task1, /^Workstream: alpha; gamma$/m);
  assert.match(task1, /^Until stop: yes/m);
  assert.match(fs.readFileSync(path.join(runDirs[0], "PLAN.md"), "utf-8"), /layer 1 \(owner member-1\): alpha\n- layer 2 \(owner member-2\): gamma/);
  const system1 = fs.readFileSync(path.join(runDirs[0], "SYSTEM.md"), "utf-8");
  assert.match(system1, /one of 2 hordes working the same task/);
  assert.ok(system1.includes(`- h2: ${hordeDirs[1]}/ (workstream: beta; delta)`), system1);
  assert.ok(!system1.includes(`- h1: ${hordeDirs[0]}`), "a horde does not list itself as a sibling");

  await wait(3000);
  for (const [i, runDir] of runDirs.entries()) {
    for (const name of ["member-1", "member-2"]) {
      const text = fs.readFileSync(path.join(runDir, `${name}.log`), "utf-8");
      assert.ok(spawns(text) >= 2, `${runIds[i]} ${name} continued under --until-stop:\n${text}`);
      assert.match(text, /^\[horde\] continue 1: until-stop: earlier session finished$/m);
      const first = text.split("\n").find((l) => l.startsWith("[horde] spawn:"));
      assert.match(first, new RegExp(`Your horde is h${i + 1} of 2 hordes`), "the identity line names the horde");
      assert.match(first, /Work only on your horde's workstream/);
      assert.match(first, /This run continues until the user stops it/);
      const env = JSON.parse(fs.readFileSync(path.join(runDir, `${name}.env.json`), "utf-8"));
      const siblings = JSON.parse(env.siblings);
      assert.deepEqual(siblings, [{ label: i === 0 ? "h2" : "h1", hordeDir: hordeDirs[i === 0 ? 1 : 0] }]);
      assert.doesNotMatch(env.role, /horde is h/, "the slice is not part of the role");
    }
    const runStart = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.action === "run-start");
    assert.equal(runStart.payload.swarm, swarmId);
    assert.equal(runStart.payload.horde, i + 1);
    assert.equal(runStart.payload.untilStop, true);
    assert.ok(!fs.existsSync(path.join(runDir, "REPORT.md")), `${runIds[i]} keeps running until stopped`);
  }
  assert.match(fs.readFileSync(path.join(runDirs[0], "member-1.log"), "utf-8"), /alpha/, "h1 member-1 owns layer alpha");
  assert.match(fs.readFileSync(path.join(runDirs[1], "member-1.log"), "utf-8"), /beta/, "h2 member-1 owns layer beta");
  console.log("PASS: horde-swarm-test launch");

  // ---- the widget shows one line per horde ------------------------------------
  const widgetLines = widgets[0].render(200);
  assert.match(widgetLines[0], new RegExp(`^swarm ${swarmId}  2 hordes`));
  assert.equal(widgetLines.length, 3, widgetLines.join("\n"));
  assert.match(widgetLines[1], /^ . h1  /);
  assert.match(widgetLines[2], /^ . h2  /);

  // ---- a second launch is refused while the swarm is active -------------------
  let mark = notifications.length;
  await command.handler("1 another", ctx);
  assert.ok(since(mark).some((n) => n.startsWith(`error: swarm ${swarmId} is still active`)), since(mark).join("\n"));

  // ---- completions offer horde-prefixed targets ------------------------------
  const targets = command.getArgumentCompletions("stop-clean h");
  assert.deepEqual(targets.map((i) => i.label).sort(), ["h1", "h1:member-1", "h1:member-2", "h2", "h2:member-1", "h2:member-2"]);
  assert.ok(command.getArgumentCompletions("pause ").some((i) => i.value === "pause all" && /2 hordes/.test(i.description)));

  // ---- sibling reads: shared read, local write ---------------------------------
  const inH2 = (member, params) => actions.runHordeAction(hordeDirs[1], member, params, runIds[1]);
  const fromH1 = (params) => actions.runHordeAction(hordeDirs[0], "member-1", params, runIds[0], { siblings: [{ label: "h2", hordeDir: hordeDirs[1] }] });
  await inH2("member-1", { action: "fact", text: "php 8.2 is installed at /usr/bin/php" });
  await inH2("member-1", { action: "resource", text: "php lab", note: `${cwd}/lab` });
  await inH2("member-1", { action: "idea", text: "look at the parser" });
  const dead = await inH2("member-2", { action: "idea", text: "check the old cache layer" });
  await inH2("member-2", { action: "claim", id: dead.id });
  await inH2("member-2", { action: "rule-out", id: dead.id, text: "removed in 2024" });
  const facts = await fromH1({ action: "facts" });
  assert.match(facts.text, /^FACTS\.md has no facts yet/);
  assert.match(facts.text, /\[h2\] facts of horde h2 \(read-only; .*h2\):\n\[h2\] T1 php 8\.2 is installed at \/usr\/bin\/php @member-1/);
  const list = await fromH1({ action: "list" });
  assert.match(list.text, new RegExp(`\\[h2\\] #${dead.id} \\[!\\] @member-2 check the old cache layer: removed in 2024`));
  assert.ok(!list.text.includes("look at the parser"), "open sibling ideas are not listed");
  const resources = await fromH1({ action: "resources" });
  assert.match(resources.text, /\[h2\] R1 php lab @member-1/);
  assert.match(resources.text, /reuse by path/);
  const unreadable = await actions.runHordeAction(hordeDirs[0], "member-1", { action: "facts" }, runIds[0], { siblings: [{ label: "h3", hordeDir: path.join(cwd, "missing") }] });
  assert.match(unreadable.text, /\[h3\] none/, "a sibling with no ledgers reads as empty");
  assert.ok(!fs.readFileSync(path.join(hordeDirs[0], "FACTS.md"), "utf-8").includes("php 8.2"), "reads write nothing");
  console.log("PASS: horde-swarm-test sibling reads");

  // ---- targets: a horde, a member of one horde, a member in every horde --------
  mark = notifications.length;
  await command.handler("status h2", ctx);
  const status = since(mark).find((n) => n.startsWith("info: horde"));
  assert.match(status, new RegExp(`^info: horde ${runIds[1]}`));
  assert.ok(!status.includes(runIds[0]), "status h2 shows only h2");
  mark = notifications.length;
  await command.handler("status", ctx);
  const both = since(mark).find((n) => n.startsWith("info: horde"));
  assert.ok(both.includes(runIds[0]) && both.includes(runIds[1]), "status shows one block per horde");
  mark = notifications.length;
  await command.handler("pause h3", ctx);
  assert.ok(since(mark).some((n) => n === "error: no such horde: h3"), since(mark).join("\n"));
  mark = notifications.length;
  await command.handler("pause h1:member-9", ctx);
  assert.ok(since(mark).some((n) => n === "error: no such member: h1:member-9"), since(mark).join("\n"));
  mark = notifications.length;
  await command.handler("stop-clean h2:member-2", ctx);
  assert.ok(since(mark).some((n) => n.startsWith("warning: h2: stop-clean: 1 member(s) wrapping up")), since(mark).join("\n"));
  assert.deepEqual(signals.readCleanStop(runDirs[1]).members, ["member-2"]);
  assert.equal(signals.readCleanStop(runDirs[0]), undefined, "h1 is untouched");
  mark = notifications.length;
  await command.handler("stop-clean member-1", ctx);
  const warned = since(mark).filter((n) => /stop-clean: 1 member\(s\) wrapping up/.test(n));
  assert.equal(warned.length, 2, `a bare member names it in every horde:\n${since(mark).join("\n")}`);
  assert.deepEqual(signals.readCleanStop(runDirs[0]).members, ["member-1"]);
  assert.deepEqual(signals.readCleanStop(runDirs[1]).members.sort(), ["member-1", "member-2"]);
  console.log("PASS: horde-swarm-test targets");

  // ---- stop-clean all: every horde finalizes, then the swarm merges --------------
  mark = notifications.length;
  await command.handler("stop-clean", ctx);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !fs.existsSync(path.join(swarmDir, "REPORT.md"))) await wait(200);
  assert.ok(fs.existsSync(path.join(swarmDir, "REPORT.md")), `the swarm report was written:\n${since(mark).join("\n")}`);
  for (const runDir of runDirs) assert.ok(fs.existsSync(path.join(runDir, "REPORT.md")), `${runDir} finalized`);
  const report = fs.readFileSync(path.join(swarmDir, "REPORT.md"), "utf-8");
  assert.match(report, new RegExp(`^# Swarm ${swarmId}$`, "m"));
  assert.match(report, /^- hordes: 2 x 2 members$/m);
  assert.match(report, /^- outcomes: h1 stopped-clean, h2 stopped-clean$/m);
  assert.match(report, /^- merged deliverable: not written$/m);
  assert.match(report, /\| h1 \| .*-h1 \| stopped-clean \| 2 \|/);
  assert.match(report, /\| total \| \| \| 4 \|/);
  assert.match(report, /^- h1: alpha; gamma$/m);
  const record = JSON.parse(fs.readFileSync(path.join(swarmDir, "SWARM.json"), "utf-8"));
  assert.equal(record.runs.length, 2);
  assert.equal(record.runs[0].outcome, "stopped-clean");
  assert.ok(record.merge.startedAt <= record.merge.endedAt);
  assert.equal(record.merge.written, false);
  assert.ok(record.endedAt >= record.startedAt);
  assert.equal(sent.length, 1, "one swarm report, no per-horde reports");
  assert.equal(sent[0].msg.customType, "agent-horde-swarm-report");
  assert.equal(sent[0].msg.details.hordes.length, 2);
  assert.match(sent[0].msg.content, new RegExp(`^Swarm ${swarmId} finished after`));
  assert.ok(sent[0].msg.content.includes(path.join(swarmDir, "REPORT.md")));
  assert.equal(sent[0].opts.triggerTurn, true, "a clean stop asks the parent to synthesize");
  assert.ok(since(mark).some((n) => n === `info: swarm ${swarmId} finished`), since(mark).join("\n"));
  await wait(300);
  mark = notifications.length;
  await command.handler("status", ctx);
  assert.ok(since(mark).some((n) => n === "info: no horde run is active"), "the slot is free after the swarm finalized");

  // ---- a swarm of one keeps the plain layout ----------------------------------
  await command.handler("1 single probe", ctx);
  await wait(800);
  const plain = fs.readdirSync(path.join(hordeDir, "runs"));
  assert.equal(plain.length, 1, "a plain run lives in .horde/runs");
  assert.doesNotMatch(plain[0], /-h\d$/);
  assert.ok(!fs.readFileSync(path.join(hordeDir, "runs", plain[0], "TASK.md"), "utf-8").includes("Swarm:"));
  await command.handler("stop-hard", ctx);
  await wait(1200);
  assert.equal(sent.length, 2, "a swarm of one sends the plain run report");
  assert.equal(sent[1].msg.customType, "agent-horde-report");
  assert.equal(fs.readdirSync(swarmsDir).length, 1, "no swarm directory for a swarm of one");

  console.log("PASS: horde-swarm-test");
  process.exit(0);
}
