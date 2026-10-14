// Fixes for the 20260915-171829 (trustlayer) postmortem:
//  A. the solved answer is a first-class ANSWER.md artifact, in full, with a status
//  B. an unvalidated solve is its own terminal state (solved-unvalidated)
//  C. facts about the same network entity (domain/IP/date) dedup and accrete a corroborator
//  D. a resource whose cited path nests with an existing one's is refused
//  E. SUMMARY.md reports per-member findings filed and claimed ideas closed
// Doubles as the fake hanging `pi --mode json` child.
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
  process.env.PI_HORDE_SOLVED_STOP_MS = "1000";

  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": PI,
      "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
      "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
      typebox: `${DEPS}/typebox/build/index.mjs`,
    },
  });
  const ledger = {
    ...(await jiti.import("../src/ledger/facts.ts")),
    ...(await jiti.import("../src/ledger/files.ts")),
    ...(await jiti.import("../src/ledger/resources.ts")),
    ...(await jiti.import("../src/ledger/run-signals.ts")),
  };
  const prompt = await jiti.import("../src/prompt.ts");
  const mod = await jiti.import("../src/index.ts");
  const actions = await jiti.import("../src/tool/actions.ts");

  // ---- A. ANSWER.md lifecycle ----------------------------------------------
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm2-a-"));
  const hordeA = ledger.initHordeDir(cwdA);
  const runA = path.join(hordeA, "runs", "R1");
  fs.mkdirSync(runA, { recursive: true });
  const longAnswer = "Related domains:\n" + Array.from({ length: 40 }, (_, i) => `- host-${i}.example`).join("\n");
  await ledger.markSolved(hordeA, "R1", "member-1", longAnswer);
  assert.ok(fs.existsSync(ledger.answerPath(runA)), "ANSWER.md is written at proposal time");
  let answer = fs.readFileSync(ledger.answerPath(runA), "utf-8");
  assert.match(answer, /Status: proposed; awaiting validation/);
  assert.ok(answer.includes("host-39.example"), "the full answer is stored, not a truncated board line");
  assert.equal(ledger.readSolved(runA).text.length, longAnswer.length, "the solved signal keeps the full text");
  await ledger.confirmSolved(hordeA, "R1", "member-2", "reproduced");
  answer = fs.readFileSync(ledger.answerPath(runA), "utf-8");
  assert.match(answer, /Status: validated by member-2/, "confirmation upgrades the answer status");
  // A contest on a fresh run marks the answer contested.
  const runA2 = path.join(hordeA, "runs", "R2");
  fs.mkdirSync(runA2, { recursive: true });
  await ledger.markSolved(hordeA, "R2", "member-1", "premature");
  await ledger.contestSolved(hordeA, "R2", "member-3", "no live evidence");
  assert.match(fs.readFileSync(ledger.answerPath(runA2), "utf-8"), /Status: contested by member-3/);

  // ---- C. fact dedup on a network entity + corroborator accretion ----------
  const cwdC = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm2-c-"));
  const hordeC = ledger.initHordeDir(cwdC);
  const t1 = await ledger.addFact(hordeC, "member-1", "example.com RDAP: registrar RegistrarCo, created 2025-10-08, expires 2026-10-08");
  const t2 = await ledger.addFact(hordeC, "member-2", "RDAP for example.com shows registrar RegistrarCo and creation 2025-10-08");
  assert.equal(t2.duplicateOf?.id, t1.fact.id, "a reworded RDAP fact about the same domain is a duplicate");
  const t3 = await ledger.addFact(hordeC, "member-3", "example.com resolves to 192.0.2.5 through Route53 nameservers");
  assert.equal(t3.duplicateOf, undefined, "a different field set for the same domain is a distinct fact");
  const factsC = ledger.listFacts(hordeC);
  assert.equal(factsC.length, 2, "the two duplicates fold into one fact; the distinct one is kept");
  assert.deepEqual(factsC.find((f) => f.id === t1.fact.id).corroborators, ["member-2"], "the second reporter is a corroborator");

  // ---- D. resource ancestor-path refusal -----------------------------------
  const cwdD = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm2-d-"));
  const hordeD = ledger.initHordeDir(cwdD);
  await ledger.claimResource(hordeD, "member-1", { name: "indicator corpus", note: "normalized rows under artifacts/osint/indicators" });
  await assert.rejects(
    ledger.claimResource(hordeD, "member-2", { name: "whole osint tree", note: "the entire artifacts/osint directory" }),
    /overlaps R1.*reuse R1/,
    "a resource whose path is an ancestor of an existing one is refused",
  );
  // A disjoint path is still allowed.
  const disjoint = await ledger.claimResource(hordeD, "member-2", { name: "kit fingerprints", note: "captures under artifacts/kits/frames" });
  assert.equal(disjoint.reused, false, "a disjoint resource path is accepted");

  // ---- E. per-member metrics in SUMMARY.md ---------------------------------
  const member = (name) => ({
    name, index: Number(name.split("-")[1]), status: "stopped", turns: 1, toolCalls: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, lastText: "", finalText: "done", startedAt: Date.now(),
  });
  const summary = prompt.summaryMarkdown({
    id: "R1", prompt: "p", count: 2, members: [member("member-1"), member("member-2")],
    startedAt: Date.now() - 1000, stopped: true,
    findings: [{ id: 1, author: "member-1", corroborators: [] }, { id: 2, author: "member-1", corroborators: [] }],
    ideas: [{ id: 1, mark: "x", owner: "member-1", text: "a" }, { id: 2, mark: "x", owner: "member-2", text: "b" }],
  });
  assert.match(summary, /## member-1[\s\S]*?2 findings filed, 0 independently reviewed \(scoped\), 0 legacy verification labels, 1 claimed idea\(s\) closed/, "member-1 metrics are reported");
  assert.match(summary, /## member-2[\s\S]*?0 findings filed, 0 independently reviewed \(scoped\), 0 legacy verification labels, 1 claimed idea\(s\) closed/, "member-2 produced no findings");

  // ---- B. unvalidated solve is its own terminal state (live run) -----------
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm2-b-"));
  const commands = new Map();
  const pi = {
    registerTool: () => {},
    registerCommand: (n, d) => commands.set(n, d),
    registerMessageRenderer: () => {},
    on: () => {},
    sendMessage: () => {},
  };
  mod.default(pi);
  const ui = { notify: () => {}, setWidget: () => {}, setStatus: () => {} };
  const ctx = { cwd, hasUI: false, ui, model: undefined, thinkingLevel: undefined, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");
  const hordeDir = path.join(cwd, ".horde");
  const runDirs = () => fs.readdirSync(path.join(hordeDir, "runs")).filter((d) => fs.statSync(path.join(hordeDir, "runs", d)).isDirectory());
  const waitFile = async (p, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !fs.existsSync(p)) await wait(50);
    assert.ok(fs.existsSync(p), `waited for ${p}`);
  };

  await command.handler("1 find related infrastructure for the target host", ctx);
  await wait(800);
  const runB = runDirs()[0];
  await actions.runHordeAction(hordeDir, "member-1", { action: "solved", text: "the operator also controls host-b.example" }, runB);
  await wait(200);
  await command.handler("stop-hard", ctx);
  await waitFile(path.join(hordeDir, "runs", runB, "REPORT.md"));
  const report = fs.readFileSync(path.join(hordeDir, "runs", runB, "REPORT.md"), "utf-8");
  assert.match(report, /^- outcome: solved-unvalidated$/m, "an unconfirmed solve is its own terminal state");
  assert.match(report, /- answer: ANSWER\.md/, "the report links the answer artifact");
  const finalAnswer = fs.readFileSync(path.join(hordeDir, "runs", runB, "ANSWER.md"), "utf-8");
  assert.match(finalAnswer, /Status: unvalidated \(no independent confirmation\)/);
  assert.match(finalAnswer, /host-b\.example/, "the full answer survives finalize");

  console.log("PASS: horde-postmortem2-test");
  process.exit(0);
}
