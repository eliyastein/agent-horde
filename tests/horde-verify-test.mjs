// Verified tier: `horde verify` records an independent reproduction on a finding,
// the reporter and corroborators cannot verify, verified clusters rank first, and
// unpartitioned runs of three or more members give the last member the verifier
// role unless --no-verifier is passed. Doubles as the hanging fake child.
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
  process.env.PI_HORDE_STALL_MS = "0";

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
    ...(await jiti.import("../src/ledger/board.ts")),
    ...(await jiti.import("../src/ledger/clusters.ts")),
    ...(await jiti.import("../src/ledger/files.ts")),
    ...(await jiti.import("../src/ledger/findings.ts")),
  };
  const prompt = await jiti.import("../src/prompt.ts");
  const mod = await jiti.import("../src/index.ts");
  const actions = await jiti.import("../src/tool/actions.ts");

  // ---- board level -----------------------------------------------------------
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-verify-"));
  const hordeDir = ledger.initHordeDir(cwd);
  await ledger.appendRunHeading(hordeDir, "R1", "verify probe");
  const file = (author, text, meta) =>
    ledger.addFinding(hordeDir, "R1", author, text, { support: "sourced", ...meta });
  const weak = await file("member-1", "Weak but real\nsource-level reasoning only", {
    concern: "weak-path-authz", concernDef: "weak endpoint trusts the caller id", importance: "low",
  });
  const strong = await file("member-2", "Strong claim\nran it live", {
    concern: "strong-path-authz", concernDef: "strong endpoint skips the role gate", importance: "critical",
    support: "reproduced",
  });
  await file("member-3", "Weak but real\nsource-level reasoning only, restated", { concern: "weak-path-authz" });
  assert.deepEqual(ledger.listFindingsForRun(hordeDir, "R1").find((f) => f.id === weak.finding.id).corroborators, ["member-3"]);

  await assert.rejects(ledger.verifyFinding(hordeDir, "R1", "member-1", { id: weak.finding.id, support: "reproduced", text: "mine" }), /reporter cannot verify/);
  await assert.rejects(ledger.verifyFinding(hordeDir, "R2", "member-2", { id: weak.finding.id, support: "reproduced", text: "wrong run" }), /is not in run R2/);
  await assert.rejects(ledger.verifyFinding(hordeDir, "R1", "member-2", { id: weak.finding.id, support: "solid", text: "bad class" }), /needs the support level/);
  await assert.rejects(ledger.verifyFinding(hordeDir, "R1", "member-2", { id: weak.finding.id, support: "reproduced", text: "" }), /text is required/);
  const verified = await ledger.verifyFinding(hordeDir, "R1", "member-2", { id: weak.finding.id, support: "reproduced", text: "curl -H auth: none /weak returns 200 with the record" });
  assert.equal(verified.alreadyBy, undefined);
  assert.equal(verified.finding.verifiedBy, "member-2");
  const again = await ledger.verifyFinding(hordeDir, "R1", "member-4", { id: weak.finding.id, support: "derived", text: "again" });
  assert.equal(again.alreadyBy, "member-2", "a second verifier does not overwrite the first");
  await ledger.verifyFinding(hordeDir, "R1", "member-3", { id: weak.finding.id, support: "tested", text: "new experiment by earlier corroborator" });

  const findings = ledger.listFindingsForRun(hordeDir, "R1");
  const weakEntry = findings.find((f) => f.id === weak.finding.id);
  assert.equal(weakEntry.verifiedBy, "member-2");
  assert.equal(weakEntry.verifiedSupport, "reproduced");
  assert.deepEqual(weakEntry.corroborators, ["member-3"], "verification does not disturb corroborators");
  assert.match(weakEntry.body, /\nVerified by member-2 \[reproduced\]: curl -H auth: none \/weak returns 200 with the record/);
  assert.match(weakEntry.body, /Verified by member-4 \[derived\]: again/);
  assert.match(weakEntry.body, /new experiment by earlier corroborator/);
  const raw = fs.readFileSync(path.join(hordeDir, "FINDINGS.md"), "utf-8");
  assert.match(raw, new RegExp(`\\[F${weak.finding.id}\\] .* concern=weak-path-authz corr=member-3 verified=member-2 vsupport=reproduced$`, "m"));
  assert.equal(ledger.parseFindings(raw).length, 2, "the note stays inside the finding's body");

  // Ranking: a verified low/source-reviewed cluster outranks an unverified critical/runtime one.
  const clusters = ledger.clusterFindings(findings);
  assert.equal(clusters[0].representative.id, weak.finding.id);
  assert.equal(clusters[1].representative.id, strong.finding.id);
  assert.match(ledger.findingSummaries(hordeDir, "R1"), /Weak but real.*\+member-3 verified by member-2/);

  // The report shows the verifier, the verified count, and the per-finding tag.
  const member = (name) => ({ name, index: 1, status: "done", turns: 1, toolCalls: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, lastText: "", finalText: "", startedAt: 0 });
  const report = prompt.runReportMarkdown({
    id: "R1", prompt: "verify probe", count: 3, members: [member("member-1"), member("member-2"), member("member-3")],
    startedAt: 0, stopped: false, outcome: "completed", findings, clusters, claims: [], facts: [], verifier: "member-3", resets: [],
  });
  assert.match(report, /^- verifier: member-3$/m);
  assert.match(report, /^- legacy verification labels: 1 /m);
  assert.match(report, /independent scoped review coverage: 0 of 2 current findings/);
  assert.match(report, /ranked by review status, then legacy\/support ranking/);
  assert.match(report, new RegExp(`^1\\. Weak but real .*\\n   - F${weak.finding.id} .*review=legacy member-1:`, "m"));
  const summary = prompt.summaryMarkdown({
    id: "R1", prompt: "verify probe", count: 3, members: [member("member-2")], startedAt: 0, stopped: false, findings, ideas: [],
  });
  assert.match(summary, /1 findings filed, 0 independently reviewed \(scoped\), 1 legacy verification labels, 0 claimed idea\(s\) closed/);

  // ---- tool level: verify, and a non-owner correction via supersedes ------------
  const runAction = (name, params, runId = "R1") => actions.runHordeAction(hordeDir, name, params, runId);
  const idea = await runAction("member-1", { action: "idea", text: "verify tool probe" });
  await runAction("member-1", { action: "claim", id: idea.id });
  const filed = await runAction("member-1", {
    action: "finding", idea: idea.id, concern: "tool-verify-authz", concernDef: "tool probe definition",
    support: "speculative", importance: "high", text: "Tool level finding\nbody",
  });
  const v = await runAction("member-3", { action: "verify", id: filed.id, support: "derived", text: "harness reproduces it" });
  assert.equal(v.text, `Verified F${filed.id} [derived] by member-3: Tool level finding`);
  const dupV = await runAction("member-4", { action: "verify", id: filed.id, support: "derived", text: "me too" });
  assert.equal(dupV.text, `F${filed.id} was already verified by member-3`);
  await assert.rejects(runAction("member-3", { action: "verify", support: "speculative", text: "x" }), /id is required for action 'verify'/);
  await assert.rejects(
    runAction("member-3", { action: "finding", idea: idea.id, concern: "tool-verify-authz", support: "speculative", text: "Not mine\nbody" }),
    /owned by member-1; claim it before filing, or use deltaOf\/supersedes/,
  );
  const corrected = await runAction("member-3", {
    action: "finding", idea: idea.id, concern: "tool-verify-authz", support: "reproduced",
    supersedes: filed.id, text: "Does not reproduce\nthe handler checks the session after all",
  });
  assert.match(corrected.text, /Recorded finding F\d+ \[tool-verify-authz\]/);
  assert.equal(ledger.listFindingsForRun(hordeDir, "R1").find((f) => f.id === filed.id).supersededBy, corrected.id);

  // ---- spawn level: default verifier role and --no-verifier ----------------------
  const spawnCwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-verify-spawn-"));
  const spawnHorde = path.join(spawnCwd, ".horde");
  const commands = new Map();
  const pi = { registerTool: () => {}, registerCommand: (n, d) => commands.set(n, d), registerMessageRenderer: () => {}, on: () => {}, sendMessage: () => {} };
  mod.default(pi);
  const ui = { notify: () => {}, setWidget: () => {}, setStatus: () => {} };
  const ctx = { cwd: spawnCwd, hasUI: false, ui, model: undefined, thinkingLevel: undefined, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");
  const runDirs = () => fs.readdirSync(path.join(spawnHorde, "runs")).sort();
  const spawnLine = (dir, name) => fs.readFileSync(path.join(dir, `${name}.log`), "utf-8").split("\n").find((l) => l.startsWith("[horde] spawn:"));

  await command.handler("3 verify probe", ctx);
  await wait(1500);
  const dir1 = path.join(spawnHorde, "runs", runDirs()[0]);
  assert.match(fs.readFileSync(path.join(dir1, "TASK.md"), "utf-8"), /^Verifier: member-3$/m);
  assert.match(spawnLine(dir1, "member-3"), /You are member-3\. You are the verifier\. Reproduce the highest-importance unverified findings first/);
  assert.doesNotMatch(spawnLine(dir1, "member-2"), /verifier/);
  assert.doesNotMatch(spawnLine(dir1, "member-1"), /verifier/);
  await command.handler("stop-hard", ctx);
  await wait(1200);
  assert.match(fs.readFileSync(path.join(dir1, "REPORT.md"), "utf-8"), /^- verifier: member-3$/m);

  await command.handler("--no-verifier 3 verify probe", ctx);
  await wait(1500);
  const dir2 = path.join(spawnHorde, "runs", runDirs()[1]);
  assert.match(fs.readFileSync(path.join(dir2, "TASK.md"), "utf-8"), /^Verifier: none$/m);
  for (const name of ["member-1", "member-2", "member-3"]) assert.doesNotMatch(spawnLine(dir2, name), /verifier/, name);
  await command.handler("stop-hard", ctx);
  await wait(1200);

  await command.handler("2 verify probe", ctx);
  await wait(1500);
  const dir3 = path.join(spawnHorde, "runs", runDirs()[2]);
  assert.doesNotMatch(spawnLine(dir3, "member-2"), /verifier/, "two members are too few for a verifier");
  await command.handler("stop-hard", ctx);
  await wait(1200);

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(spawnCwd, { recursive: true, force: true });
  console.log("PASS: horde-verify-test");
  process.exit(0);
}
