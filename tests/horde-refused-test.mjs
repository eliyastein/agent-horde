// A session the provider refused is not answered with a fresh one: the member stays down with
// cause `refused`, its ideas return to the pool, and a refused canary stops the run without the
// usual retry. A plain model error is still reset. Doubles as the fake child: REFUSED_PROBE_MODE
// picks which members are refused (`member-2`, or `canary` for member-1); member-3 always ends
// on a transport error.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

if (process.argv.includes("--mode")) {
  const name = process.env.PI_HORDE_NAME;
  const countFile = path.join(process.env.REFUSED_PROBE_DIR, `${name}.spawns`);
  const spawns = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf-8")) : 0) + 1;
  fs.writeFileSync(countFile, String(spawns));
  emit({ type: "agent_start" });
  const refusedMember = process.env.REFUSED_PROBE_MODE === "canary" ? "member-1" : "member-2";
  if (name === refusedMember) {
    if (name === "member-2") {
      const jiti = createJiti(import.meta.url, { fsCache: false });
      const ledger = await jiti.import("../src/ledger/ideas.ts");
      const { idea } = await ledger.addIdea(process.env.PI_HORDE_DIR, name, "refused probe idea held by the refused session");
      await ledger.claimIdea(process.env.PI_HORDE_DIR, name, idea.id);
    }
    emit({
      type: "message_end",
      message: {
        role: "assistant", content: [], usage, stopReason: "error", rawStopReason: "refusal",
        errorMessage: "The model refused to complete the request",
      },
    });
    await wait(100);
    process.exit(1);
  }
  if (name === "member-3") {
    emit({ type: "message_end", message: { role: "assistant", content: [], usage, stopReason: "error", errorMessage: "503 upstream unavailable" } });
    await wait(100);
    process.exit(1);
  }
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }], usage, stopReason: "stop" } });
  setInterval(() => {}, 1000);
} else {
  for (const key of ["PI_HORDE_MEMBER", "PI_HORDE_DIR", "PI_HORDE_NAME", "PI_HORDE_RUN"]) delete process.env[key];
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "2000";
  process.env.PI_HORDE_STALL_MS = "0";
  process.env.PI_HORDE_RESET_CAP = "1";

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

  // ---- classification: only a positively identified refusal counts --------------
  const errored = (extra) => ({ role: "assistant", stopReason: "error", ...extra });
  assert.equal(member.isRefusal(errored({ rawStopReason: "refusal", errorMessage: "I can't help with that" })), true);
  assert.equal(member.isRefusal(errored({ rawStopReason: "SAFETY" })), true, "provider reasons match in any case");
  assert.equal(member.isRefusal(errored({ rawStopReason: "incomplete.content_filter" })), true);
  assert.equal(member.isRefusal(errored({ errorMessage: "Provider finish_reason: content_filter" })), true, "pi's own error text names the reason");
  assert.equal(member.isRefusal(errored({ errorMessage: "Provider stopped with: sensitive" })), true);
  assert.equal(member.isRefusal(errored({ errorMessage: "Provider finish_reason: network_error" })), false);
  assert.equal(member.isRefusal(errored({ errorMessage: "429 rate limited" })), false);
  assert.equal(member.isRefusal(errored({})), false, "an error with no detail stays a model error");
  assert.equal(member.isRefusal({ role: "assistant", stopReason: "stop", rawStopReason: "refusal" }), false, "only an errored message is a refusal");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-refused-"));
  const probeDir = path.join(cwd, "probe");
  fs.mkdirSync(probeDir);
  process.env.REFUSED_PROBE_DIR = probeDir;
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
  const spawnsOf = (name) => (fs.existsSync(path.join(probeDir, `${name}.spawns`)) ? fs.readFileSync(path.join(probeDir, `${name}.spawns`), "utf-8") : "0");

  // ---- a refused member stays down; a model error beside it is still reset -------
  process.env.REFUSED_PROBE_MODE = "member-2";
  await command.handler("--no-verifier 3 refused probe", ctx);
  await wait(3000);
  const dir1 = path.join(hordeDir, "runs", runDirs()[0]);
  const m2 = log(dir1, "member-2");
  assert.equal(count(m2, /^\[horde\] spawn:/gm), 1, `a refused member is not respawned:\n${m2}`);
  assert.match(m2, /^\[horde\] exit code 1 status failed cause refused(?: partial)?$/m);
  assert.match(m2, /^\[horde\] refused by the provider; not reset$/m);
  assert.doesNotMatch(m2, /^\[horde\] reset/m);
  assert.equal(member.parseMemberLog(m2).endCause, "refused");
  const m3 = log(dir1, "member-3");
  assert.equal(count(m3, /^\[horde\] spawn:/gm), 2, `a model error is still reset up to the cap:\n${m3}`);
  assert.match(m3, /^\[horde\] reset 1: model_error$/m);
  const board = fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf-8");
  assert.match(board, /member-2 stays down: the provider refused its request, and a fresh session would send the same one\. Released #1; earlier claims by member-2 are void\./);
  const idea = ledger.listIdeas(hordeDir).find((i) => i.id === 1);
  assert.equal(idea.mark, " ", "the refused session's claim was released");
  assert.equal(idea.owner, undefined);

  await command.handler("stop-hard", ctx);
  await wait(1500);
  const report = fs.readFileSync(path.join(dir1, "REPORT.md"), "utf-8");
  assert.match(report, /^- member-2: failed \(refused\) /m);
  assert.match(report, /abnormal ends: .*member-2 \(refused: The model refused to complete the request\)/);
  assert.doesNotMatch(report.split("\n").find((l) => l.startsWith("- resets: ")) ?? "", /member-2/);
  const events = fs.readFileSync(path.join(dir1, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(events.some((e) => JSON.stringify(e).includes('"endCause":"refused"')), "member-exit records the cause");

  // ---- a refused canary stops the run without a retry ----------------------------
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir);
  process.env.REFUSED_PROBE_MODE = "canary";
  await command.handler("--no-verifier 2 refused canary probe", ctx);
  await wait(3000);
  const dir2 = path.join(hordeDir, "runs", runDirs()[1]);
  assert.equal(spawnsOf("member-1"), "1", "a refused canary is not retried");
  assert.equal(spawnsOf("member-2"), "0", "no fan-out after a refused canary");
  const report2 = fs.readFileSync(path.join(dir2, "REPORT.md"), "utf-8");
  assert.match(report2, /canary: failed \(the provider refused the request \(The model refused to complete the request\); not retried\)/);
  assert.ok(!notifications.some((n) => n.includes("refused canary") && n.includes("retrying once")));
  assert.ok(notifications.some((n) => /^error: .*canary failed \(the provider refused the request/.test(n)), notifications.join("\n"));

  fs.rmSync(cwd, { recursive: true, force: true });
  console.log("PASS: horde-refused-test");
  process.exit(0);
}
