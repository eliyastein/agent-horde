// Fixes for the 20260913-185358 postmortem:
//  A. a delta joins the cluster of the finding it declares, not the one its body matches
//  B. facts dedup on a shared salient identifier (archive hash)
//  C. resources dedup when their notes name the same artifact hash
//  D. `horde solved` records a proposal without pausing coverage work
//  E. finalize reconciles ~ ideas owned by any member, including normal completions
//  F. a canary that produced nothing is labeled even when a stop arrives
// Doubles as the fake `pi --mode json` child.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--mode")) {
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  if (process.env.HORDE_TEST_SILENT === "1") {
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          stopReason: "stop",
        },
      }) + "\n",
    );
    setTimeout(() => process.exit(0), 900);
  }
} else {
  delete process.env.PI_HORDE_MEMBER;
  delete process.env.PI_HORDE_DIR;
  delete process.env.PI_HORDE_NAME;
  delete process.env.PI_HORDE_RUN;
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";
  process.env.PI_HORDE_CANARY_MS = "2000";

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
    ...(await jiti.import("../src/ledger/facts.ts")),
    ...(await jiti.import("../src/ledger/files.ts")),
    ...(await jiti.import("../src/ledger/findings.ts")),
    ...(await jiti.import("../src/ledger/ideas.ts")),
    ...(await jiti.import("../src/ledger/resources.ts")),
    ...(await jiti.import("../src/ledger/run-signals.ts")),
  };
  const prompt = await jiti.import("../src/prompt.ts");
  const mod = await jiti.import("../src/index.ts");
  const actions = await jiti.import("../src/tool/actions.ts");

  // ---- A. per-finding delta fold -------------------------------------------
  const f = (id, author, deltaOf, importance, text) => ({
    id,
    runId: "R",
    author,
    title: text,
    body: text,
    explicitId: true,
    deltaOf,
    importance,
    support: "derived",
    confidence: "high",
    corroborators: [],
    headingLine: -1,
  });
  const entries = [
    f(1, "member-5", undefined, "critical", "flag Z_compiled recovered from the XOR constant"),
    f(13, "member-3", 1, "critical", "credential chain oday password Aa123456 recovered"),
    f(3, "member-1", undefined, "high", "credential chain oday password Aa123456"),
    f(6, "member-4", 3, "medium", "credential chain Resolve ordering detail"),
  ];
  const clusters = ledger.clusterFindings(entries);
  const flag = clusters.find((c) => c.representative.id === 1);
  const creds = clusters.find((c) => c.representative.id === 3);
  assert.ok(flag, "flag cluster exists");
  assert.ok(flag.findings.some((e) => e.id === 13), "a delta joins the cluster of the finding it declares");
  assert.ok(!creds.findings.some((e) => e.id === 13), "the delta does not stay in its body cluster");
  assert.ok(flag.deltaMembers.includes("member-3"), "delta author is recorded on the parent cluster");
  assert.equal(clusters[0].representative.id, 1, "the flag cluster now outranks the credentials cluster");
  assert.equal(clusters[0].members.join(","), "member-5", "delta authors are not counted as independent members");

  // ---- B. fact dedup on a shared identifier --------------------------------
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm-b-"));
  const hordeB = ledger.initHordeDir(cwdB);
  const hash = "6aa5ccb13b246e477b6c0c12";
  const t1 = await ledger.addFact(hordeB, "member-1", `Archive ${hash}.zip is ZipCrypto, password crackmes.one, entry ZSecure.exe`);
  const t2 = await ledger.addFact(hordeB, "member-2", `Zip ${hash}.zip is traditional PKZIP ZipCrypto-encrypted, name ZSecure.exe, method deflate`);
  const t3 = await ledger.addFact(hordeB, "member-3", `Zip ${hash}.zip password is crackmes.one, ZipCrypto flag 0x0001, extracts with 7zz`);
  assert.equal(t2.duplicateOf?.id, t1.fact.id, "a reworded fact about the same archive hash is a duplicate");
  assert.equal(t3.duplicateOf?.id, t1.fact.id, "a third wording is also a duplicate");
  assert.equal(ledger.listFacts(hordeB).length, 1, "only one fact is stored");
  await assert.rejects(
    ledger.addFact(hordeB, "member-1", `Archive ${hash}.zip sha256 6f2c8a... to be filled`),
    /placeholder/,
    "a placeholder fact is refused",
  );

  // ---- C. resource dedup via the note's artifact hash -----------------------
  const cwdC = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm-c-"));
  const hordeC = ledger.initHordeDir(cwdC);
  const r1 = await ledger.claimResource(hordeC, "member-1", { name: "zip-unlock-zcrypt", note: `candidate probes + ZipCrypto checker for ${hash}.zip` });
  assert.equal(r1.reused, false);
  const r4 = await ledger.claimResource(hordeC, "member-2", { name: "zipcrypto-kpa-lab", note: `known-plaintext recovery for ${hash}.zip` });
  assert.equal(r4.reused, true, "a differently named resource for the same artifact hash is reused");
  assert.equal(r4.resource.id, r1.resource.id);
  assert.deepEqual(r4.resource.reusers, ["member-2"]);
  assert.equal(ledger.listResources(hordeC).length, 1, "only one resource is stored");
  // Different versions of a different tool are still distinct.
  await ledger.claimResource(hordeC, "member-1", { name: "php8.2 lab", note: "docker php:8.2-cli" });
  const php83 = await ledger.claimResource(hordeC, "member-1", { name: "php8.3 lab", note: "docker php:8.3-cli" });
  assert.equal(php83.reused, false, "a different version token is a different resource");
  // Cleanup commands round-trip and are tracked per run.
  fs.mkdirSync(path.join(hordeC, "runs", "R1"), { recursive: true });
  const withCleanup = await ledger.claimResource(hordeC, "member-3", { name: "mock cloaker lab", note: "php -S mock on 18081", cleanup: "docker rm -f bc-mock-cloak bc-mock-clean", runId: "R1" });
  assert.equal(withCleanup.resource.cleanup, "docker rm -f bc-mock-cloak bc-mock-clean");
  const stored = ledger.listResources(hordeC).find((r) => r.id === withCleanup.resource.id);
  assert.equal(stored.cleanup, "docker rm -f bc-mock-cloak bc-mock-clean", "cleanup round-trips through RESOURCES.md");
  const pending = ledger.pendingCleanups(hordeC, "R1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].command, "docker rm -f bc-mock-cloak bc-mock-clean");
  assert.equal(ledger.pendingCleanups(hordeC, "R9").length, 0, "another run has no cleanups");
  await assert.rejects(
    ledger.claimResource(hordeC, "member-4", { name: "dangerous artifact cleanup", note: ".horde/runs/R1/artifacts/repro.py", cleanup: "trash .horde/runs/R1/artifacts", runId: "R1" }),
    /unsafe cleanup.*evidence or artifact directory/,
    "cleanup cannot delete retained run evidence",
  );
  fs.appendFileSync(
    path.join(hordeC, "RESOURCES.md"),
    "\n- [R99] legacy unsafe cleanup  @member-4: old entry  cleanup: trash .tmp/horde/R1\n",
  );
  ledger.recordRunResource(hordeC, "R1", 99);
  const legacyBlocked = ledger.pendingCleanups(hordeC, "R1").find((item) => item.id === 99);
  assert.match(legacyBlocked.blockedReason, /evidence or artifact directory/, "legacy unsafe cleanup is blocked at finalize");

  // ---- D. solved signal -----------------------------------------------------
  const cwdD = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm-d-"));
  const hordeD = ledger.initHordeDir(cwdD);
  const runD = path.join(hordeD, "runs", "R1");
  fs.mkdirSync(runD, { recursive: true });
  const first = await actions.runHordeAction(hordeD, "member-2", { action: "solved", text: "flag Z+{x}" }, "R1");
  assert.match(first.text, /Proposed SOLVED/);
  assert.ok(fs.existsSync(path.join(runD, ".solved")), ".solved written");
  assert.equal(ledger.readSolved(runD).member, "member-2");
  const sentinel = ledger.readCleanStop(runD);
  assert.equal(sentinel, undefined, "a proposal does not pause coverage work");
  const second = await actions.runHordeAction(hordeD, "member-3", { action: "solved", text: "also" }, "R1");
  assert.match(second.text, /already pending from member-2/);
  // The proposer cannot validate its own proposal; another member can.
  await assert.rejects(
    actions.runHordeAction(hordeD, "member-2", { action: "confirm-solved", text: "looks right" }, "R1"),
    /proposer cannot validate/,
  );
  const confirmed = await actions.runHordeAction(hordeD, "member-3", { action: "confirm-solved", text: "reproduced live" }, "R1");
  assert.match(confirmed.text, /Validated the SOLVED proposal/);
  assert.equal(ledger.readSolvedState(runD).confirm.member, "member-3");
  // A fresh proposal can be contested instead, and the parent then clears it.
  ledger.clearSolved(runD);
  await actions.runHordeAction(hordeD, "member-2", { action: "solved", text: "second try" }, "R1");
  const contested = await actions.runHordeAction(hordeD, "member-4", { action: "contest-solved", text: "source-only, no live evidence" }, "R1");
  assert.match(contested.text, /Contested the SOLVED proposal/);
  assert.equal(ledger.readSolvedState(runD).contest.member, "member-4");
  ledger.clearSolved(runD);
  // New work remains available until the parent validates coverage and starts wind-down.
  const continued = await actions.runHordeAction(hordeD, "member-3", { action: "idea", text: "more work" }, "R1");
  assert.match(continued.text, /Added idea/);
  // The report carries the proposal and its validation.
  await actions.runHordeAction(hordeD, "member-2", { action: "solved", text: "flag Z+{x}" }, "R1");
  await actions.runHordeAction(hordeD, "member-3", { action: "confirm-solved", text: "reproduced live" }, "R1");
  const report = prompt.runReportMarkdown({
    id: "R1", prompt: "p", count: 1, members: [], startedAt: Date.now() - 1000, stopped: true,
    outcome: "stopped-clean", findings: [], clusters: [], claims: [], facts: [],
    solved: ledger.readSolved(runD),
    solvedValidatedBy: ledger.readSolvedState(runD).confirm.member,
  });
  assert.match(report, /- solved: member-2 proposed the goal answered \(validated by member-3\): flag Z\+\{x\}/);
  const summary = prompt.summaryMarkdown({
    id: "R1", prompt: "p", count: 1,
    members: [{ name: "member-2", index: 2, status: "stopped", turns: 1, toolCalls: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, lastText: "", finalText: "", startedAt: Date.now() }],
    startedAt: Date.now() - 1000, stopped: true, stopLabel: "stopped during solved wind-down", solved: ledger.readSolved(runD),
    solvedValidatedBy: "member-3", solvedCommitted: true,
  });
  assert.match(summary, /member-2 proposed the goal solved at \d\d:\d\d:\d\d, validated by member-3; the run wound down on it\. Run stopped during solved wind-down\./);
  assert.ok(!/stopped by the user/.test(summary), "a solved run is not reported as user-stopped");
  // The full solved text is kept, not truncated at 300 chars.
  const runD2 = path.join(hordeD, "runs", "R2");
  fs.mkdirSync(runD2, { recursive: true });
  const longText = "answer: " + "x".repeat(500);
  await actions.runHordeAction(hordeD, "member-1", { action: "solved", text: longText }, "R2");
  assert.equal(ledger.readSolved(runD2).text.length, longText.length, "the solved text is stored in full");

  // ---- G. late board posts are surfaced -------------------------------------
  const cwdL = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm-late-"));
  const hordeL = ledger.initHordeDir(cwdL);
  fs.writeFileSync(
    path.join(hordeL, "FINDINGS.md"),
    ["# Findings", "", "## Run R-late (2026-01-01 00:00:00): p", "", "### 00:00:10 member-1 [F1]", "flag found", ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(hordeL, "BOARD.md"),
    [
      "# Board",
      "",
      "## Run R-late (2026-01-01 00:00:00): p",
      "",
      "### 00:00:05 member-1",
      "filed finding already",
      "",
      "### 00:02:00 member-5",
      "novel vuln that was never filed as a finding",
      "",
      "### 00:03:00 parent",
      "a parent notice, not a member result",
      "",
    ].join("\n"),
  );
  const lateFindings = ledger.parseFindings(fs.readFileSync(path.join(hordeL, "FINDINGS.md"), "utf-8")).filter((f) => f.runId === "R-late");
  assert.equal(lateFindings[0].time, "00:00:10", "finding headings keep their clock time");
  const late = ledger.lateBoardPosts(hordeL, "R-late", lateFindings);
  assert.equal(late.length, 1, "only the member post after the last finding counts");
  assert.equal(late[0].author, "member-5");
  const reportLate = prompt.runReportMarkdown({
    id: "R-late", prompt: "p", count: 2, members: [], startedAt: Date.now() - 1000, stopped: false,
    outcome: "completed", findings: lateFindings, clusters: [], claims: [], facts: [],
    lateBoardPosts: late,
  });
  assert.match(reportLate, /- late board posts: 1 after the last finding \(member-5\)/);

  // ---- E/F. live harness: reconcile-all and canary labeling -----------------
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm-ef-"));
  const commands = new Map();
  const sent = [];
  const pi = {
    registerTool: () => {},
    registerCommand: (n, d) => commands.set(n, d),
    registerMessageRenderer: () => {},
    on: () => {},
    sendMessage: (msg, opts) => sent.push({ msg, opts }),
  };
  mod.default(pi);
  const ui = { notify: () => {}, setWidget: () => {}, setStatus: () => {} };
  const ctx = { cwd, hasUI: false, ui, model: undefined, thinkingLevel: undefined, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");
  const runDirs = () => fs.readdirSync(path.join(cwd, ".horde", "runs")).filter((d) => fs.statSync(path.join(cwd, ".horde", "runs", d)).isDirectory()).sort();
  const waitFile = async (p, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !fs.existsSync(p)) await wait(50);
    assert.ok(fs.existsSync(p), `waited for ${p}`);
  };

  // E: a member that completes normally must not leave an idea stuck in progress.
  await command.handler("1 reconcile probe", ctx);
  await wait(300);
  const hordeEF = path.join(cwd, ".horde");
  const runE = runDirs()[0];
  const cleanupMarker = path.join(cwd, "cleaned.marker");
  await wait(100);
  await actions.runHordeAction(
    hordeEF,
    "member-1",
    { action: "resource", text: "cleanup probe lab", note: "mock", cleanup: `echo cleaned > ${cleanupMarker}` },
    runE,
  );
  const leftover = await ledger.addIdea(hordeEF, "member-1", "leftover in-progress idea not finished by the member");
  await ledger.claimIdea(hordeEF, "member-1", leftover.idea.id);
  assert.equal(ledger.listIdeas(hordeEF).find((i) => i.id === leftover.idea.id).mark, "~");
  await waitFile(path.join(hordeEF, "runs", runE, "REPORT.md"));
  await wait(200);
  assert.equal(
    ledger.listIdeas(hordeEF).find((i) => i.id === leftover.idea.id).mark,
    " ",
    "finalize releases the idea even though the member completed normally",
  );
  assert.ok(fs.existsSync(cleanupMarker), "finalize ran the resource cleanup command");
  const reportE = fs.readFileSync(path.join(hordeEF, "runs", runE, "REPORT.md"), "utf-8");
  assert.match(reportE, /- cleanup: 1\/1 command\(s\) succeeded/);
  assert.match(reportE, /## Cleanup/);

  // F: a canary with no output is labeled even when a stop arrives during preflight.
  process.env.HORDE_TEST_SILENT = "1";
  await command.handler("1 silent canary probe", ctx);
  await wait(400);
  await command.handler("stop-hard", ctx);
  const runF = runDirs().find((d) => d !== runE);
  await waitFile(path.join(hordeEF, "runs", runF, "REPORT.md"));
  const reportF = fs.readFileSync(path.join(hordeEF, "runs", runF, "REPORT.md"), "utf-8");
  assert.match(reportF, /- outcome: stopped-hard/, "a user stop still labels the outcome as stopped");
  assert.match(reportF, /- canary: failed/, "the canary failure is recorded even alongside the stop");
  delete process.env.HORDE_TEST_SILENT;

  console.log("PASS: horde-postmortem-fixes-test");
  process.exit(0);
}
