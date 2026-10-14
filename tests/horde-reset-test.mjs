// Stall detection and fresh-context resets: a member that exits abnormally after
// fan-out is respawned with its ideas released, a running member with no ledger
// write for PI_HORDE_STALL_MS is killed and respawned, both stop at the reset cap,
// and a member that exits during a clean stop is left down. Doubles as the fake
// child: member-1 hangs silently, member-2 exits 2 on every spawn. (A nonzero exit
// is labelled model_error whenever stderr or the exit code fills `error`, so the
// assertions accept either cause.)
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--mode")) {
  const name = process.env.PI_HORDE_NAME;
  const probeDir = process.env.RESET_PROBE_DIR;
  const countFile = path.join(probeDir, `${name}.spawns`);
  const spawns = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf-8")) : 0) + 1;
  fs.writeFileSync(countFile, String(spawns));
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  process.stdout.write(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `session ${spawns}` }],
        usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    }) + "\n",
  );
  if (name === "member-2" && process.env.RESET_PROBE_EXIT !== "off") {
    // The first session claims an idea and dies holding it; the replacement must not
    // inherit it. Later sessions die too, so the cap is exercised.
    const jiti = createJiti(import.meta.url, { fsCache: false });
    const ledger = await jiti.import("../src/ledger/ideas.ts");
    if (spawns === 1) {
      const { idea } = await ledger.addIdea(process.env.PI_HORDE_DIR, name, "reset probe idea held by the dead session");
      await ledger.claimIdea(process.env.PI_HORDE_DIR, name, idea.id);
    }
    await wait(300);
    process.exit(2);
  }
  setInterval(() => {}, 1000);
} else {
  delete process.env.PI_HORDE_MEMBER;
  delete process.env.PI_HORDE_DIR;
  delete process.env.PI_HORDE_NAME;
  delete process.env.PI_HORDE_RUN;
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "2000";
  process.env.PI_HORDE_STALL_MS = "1500";
  process.env.PI_HORDE_RESET_CAP = "2";
  process.env.PI_HORDE_ACTIVE_GRACE_MS = "300";

  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": PI,
      "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
      "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
      typebox: `${DEPS}/typebox/build/index.mjs`,
    },
  });
  const ledger = await jiti.import("../src/ledger/ideas.ts");
  const member = await jiti.import("../src/member.ts");
  const mod = await jiti.import("../src/index.ts");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-reset-"));
  const probeDir = path.join(cwd, "probe");
  fs.mkdirSync(probeDir);
  process.env.RESET_PROBE_DIR = probeDir;
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
  const runDirs = () => fs.readdirSync(path.join(hordeDir, "runs")).sort();
  const log = (dir, name) => fs.readFileSync(path.join(dir, `${name}.log`), "utf-8");
  const count = (text, re) => (text.match(re) ?? []).length;
  const CAUSE = "(?:exit_nonzero|model_error)";

  // ---- abnormal exit and stall, both capped ------------------------------------
  await command.handler("2 reset probe", ctx);
  // Canary (~0.3s) + member-2 sessions (~0.3s each, three of them) + two stall windows
  // for member-1 (1.5s each, polled every 375ms).
  await wait(6500);
  const dir1 = path.join(hordeDir, "runs", runDirs()[0]);
  const m2 = log(dir1, "member-2");
  assert.equal(count(m2, /^\[horde\] spawn:/gm), 3, `member-2 is spawned three times:\n${m2}`);
  assert.match(m2, new RegExp(`^\\[horde\\] reset 1: ${CAUSE}$`, "m"));
  assert.match(m2, new RegExp(`^\\[horde\\] reset 2: ${CAUSE}$`, "m"));
  assert.match(m2, new RegExp(`^\\[horde\\] reset cap reached \\(${CAUSE}\\)$`, "m"));
  assert.ok(m2.indexOf("reset cap reached") > m2.lastIndexOf("[horde] final: session 3"), "the cap line lands after the flushed exit lines");
  const replacementSpawn = m2.split("\n").filter((l) => l.startsWith("[horde] spawn:"))[1];
  assert.match(replacementSpawn, new RegExp(`You are member-2\\. You replace an earlier session of member-2 that was reset for ${CAUSE}; its ideas were released\\. Read BOARD\\.md and FINDINGS\\.md before claiming\\.`));
  const firstSpawn = m2.split("\n").find((l) => l.startsWith("[horde] spawn:"));
  assert.doesNotMatch(firstSpawn, /You replace/);
  const boardText = fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf-8");
  assert.match(boardText, new RegExp(`reset member-2 \\(${CAUSE}\\): released #1; closed none\\. A fresh session of member-2 starts now; earlier claims by member-2 are void\\.`));
  const idea = ledger.listIdeas(hordeDir).find((i) => i.id === 1);
  assert.equal(idea.mark, " ", "the dead session's claim was released");
  assert.equal(idea.owner, undefined);
  assert.equal(fs.readFileSync(path.join(probeDir, "member-2.spawns"), "utf-8"), "3");

  const m1 = log(dir1, "member-1");
  assert.equal(count(m1, /^\[horde\] spawn:/gm), 3, `member-1 is spawned three times:\n${m1}`);
  assert.match(m1, /^\[horde\] reset 1: stalled: no ledger write for \d+m$/m);
  assert.match(m1, /^\[horde\] reset 2: stalled: no ledger write for \d+m$/m);
  assert.ok(!fs.existsSync(path.join(dir1, ".hb-member-1")), "a stalled member never wrote a heartbeat");

  await command.handler("stop-hard", ctx);
  await wait(1500);
  const report = fs.readFileSync(path.join(dir1, "REPORT.md"), "utf-8");
  const resetsLine = report.split("\n").find((l) => l.startsWith("- resets: "));
  assert.ok(resetsLine, "the diagnosis lists the resets");
  assert.equal(count(resetsLine, new RegExp(`member-2 \\(${CAUSE}\\)`, "g")), 2, resetsLine);
  assert.equal(count(resetsLine, /member-1 \(stalled: no ledger write for \d+m\)/g), 2, resetsLine);
  assert.match(report, /^## Resets$/m);
  assert.match(report, new RegExp(`^- \\d\\d:\\d\\d:\\d\\d member-2: ${CAUSE}; released #1; closed none; lost \\d+ turns, \\d+ tool calls, \\d+ tok$`, "m"));
  assert.match(report, /^- member-1: stopped \(killed\) .*, 2 reset\(s\)$/m);
  assert.match(report, new RegExp(`^- member-2: failed \\(${CAUSE}\\) .*, 2 reset\\(s\\)$`, "m"));
  const summary = fs.readFileSync(path.join(dir1, "SUMMARY.md"), "utf-8");
  assert.match(summary, new RegExp(`^resets: 2 \\(${CAUSE}; ${CAUSE}\\)$`, "m"));
  assert.match(summary, /^resets: 2 \(stalled: no ledger write for \d+m; stalled: no ledger write for \d+m\)$/m);
  const parsed = member.parseMemberLog(m2);
  assert.equal(parsed.resets.length, 2);
  assert.match(parsed.resets[0], new RegExp(`^${CAUSE}$`));
  assert.match(parsed.endCause, new RegExp(`^${CAUSE}$`));
  assert.match(report, /^- resets:.*$/m);

  // ---- a clean stop leaves an exiting member down ------------------------------
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir);
  process.env.PI_HORDE_STALL_MS = "0";
  await command.handler("2 clean probe", ctx);
  await wait(400);
  await command.handler("stop-clean --grace 1", ctx);
  await wait(4000);
  const dir2 = path.join(hordeDir, "runs", runDirs()[1]);
  const m2clean = log(dir2, "member-2");
  assert.equal(count(m2clean, /^\[horde\] spawn:/gm), 1, `no respawn during a clean stop:\n${m2clean}`);
  assert.doesNotMatch(m2clean, /^\[horde\] reset/m);
  assert.ok(fs.existsSync(path.join(dir2, "REPORT.md")), "the clean stop finalized");
  assert.doesNotMatch(fs.readFileSync(path.join(dir2, "REPORT.md"), "utf-8"), /^- resets:/m);

  fs.rmSync(cwd, { recursive: true, force: true });
  console.log("PASS: horde-reset-test");
  process.exit(0);
}
