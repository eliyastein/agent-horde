// Regression tests for the synthesis-visibility work and the two report fixes:
// - the dashboard/TUI show a `synthesizing` state while DELIVERABLE/POSTMORTEM run
// - a killed member with 1 turn and no tokens/tools/text is not "partial work"
// - delta authors are listed separately from independent agreement
// - a delta whose body names a different finding is refused
// This file doubles as the fake `pi --mode json` child.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--mode")) {
  // One empty assistant turn (no text, no usage, no tools), then hang so the
  // parent has to kill us: the exact 180557 shape.
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  process.stdout.write(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    }) + "\n",
  );
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
  const ledger = {
    ...(await jiti.import("../src/ledger/board.ts")),
    ...(await jiti.import("../src/ledger/clusters.ts")),
    ...(await jiti.import("../src/ledger/files.ts")),
    ...(await jiti.import("../src/ledger/findings.ts")),
  };
  const data = await jiti.import("../src/dashboard-data.ts");
  const dash = await jiti.import("../src/dashboard.ts");
  const widget = await jiti.import("../src/widget.ts");
  const member = await jiti.import("../src/member.ts");
  const prompt = await jiti.import("../src/prompt.ts");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-finalizing-"));
  const hordeDir = ledger.initHordeDir(cwd);
  const runId = "20260101-120000";
  const runDir = path.join(hordeDir, "runs", runId);
  fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), `# Horde run ${runId}\n\nStarted: 2026-01-01 12:00:00\nMembers: 1\n\n## Prompt\n\nprobe\n`);
  // REPORT.md exists already (written before the helpers), the synthesis files do not.
  fs.writeFileSync(path.join(runDir, "REPORT.md"), "# Run report\n\n## Diagnosis\n\n- outcome: completed\n");

  const finalizingRun = {
    id: runId,
    hordeDir,
    runDir,
    prompt: "probe",
    count: 1,
    startedAt: Date.now() - 60_000,
    stopped: true,
    startFactId: 0,
    canary: "ok",
    finalizing: ["post-mortem", "deliverable"],
    members: [
      Object.assign(member.newMemberState(1), {
        status: "done",
        turns: 3,
        endedAt: Date.now() - 1_000,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 },
      }),
    ],
  };
  const source = { hordeDir, getActive: () => [], getFinalizing: () => [finalizingRun] };

  // Run overview reports synthesizing, not completed.
  const overview = data.loadRunOverview(source, runId);
  assert.equal(overview.active, false);
  assert.equal(overview.outcome, "synthesizing");
  assert.deepEqual(overview.finalizing, ["post-mortem", "deliverable"]);
  const index = data.listRuns(source);
  const row = index.runs.find((r) => r.id === runId);
  assert.equal(row.active, false);
  assert.equal(row.finalizing, true);
  assert.equal(row.outcome, "synthesizing");

  // The HTTP page is treated as live (auto-refresh) and shows the state.
  const res = dash.routeRequest(source, "GET", new URL(`http://127.0.0.1/runs/${runId}`), "127.0.0.1");
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('http-equiv="refresh"'), "finalizing overview should auto-refresh");
  assert.ok(res.body.includes("synthesizing"), "overview should name the state");
  assert.ok(res.body.includes("post-mortem"), "overview should list the pending steps");
  const indexRes = dash.routeRequest(source, "GET", new URL("http://127.0.0.1/"), "127.0.0.1");
  assert.ok(indexRes.body.includes("finalizing"), "run index should show finalizing");
  // Other runs still read as finished once this one clears.
  const doneSource = { hordeDir, getActive: () => [], getFinalizing: () => [] };
  assert.equal(data.loadRunOverview(doneSource, runId).outcome, "completed");

  // Widget header names the synthesis steps.
  const theme = { fg: (_c, s) => s, bold: (s) => s };
  const header = widget.headerLine(finalizingRun, Date.now(), theme);
  assert.match(header, /synthesizing post-mortem, deliverable/);

  // A 1-turn, 0-token, 0-tool member that is killed is not "partial work".
  const m = member.newMemberState(1);
  const controller = new AbortController();
  const spawnRun = { id: "R1", hordeDir, runDir, prompt: "probe", count: 1 };
  const done = member.spawnMember({
    member: m,
    run: spawnRun,
    cwd,
    model: undefined,
    thinkingLevel: undefined,
    approve: false,
    signal: controller.signal,
    onChange: () => {},
  });
  await wait(600);
  controller.abort();
  await done;
  assert.equal(m.turns, 1, "the empty assistant turn still counts as a turn");
  assert.equal(m.endCause, "killed");
  assert.notEqual(m.partial, true, "no tokens, no tools, no text must not read as partial work");

  // Delta authors are listed separately from independent agreement.
  await ledger.appendRunHeading(hordeDir, "R-meta", "meta");
  const base = await ledger.addFinding(
    hordeDir, "R-meta", "member-1", "vendor alpha endpoint /api/v1/check leaks header X-Key",
    { concern: "vendor-check-authz", concernDef: "vendor check authz root cause and entry point" },
  );
  const dup = await ledger.addFinding(
    hordeDir, "R-meta", "member-2", "vendor alpha endpoint /api/v1/check leaks header X-Key",
    { concern: "vendor-check-authz", concernDef: "vendor check authz root cause and entry point" },
  );
  assert.equal(dup.duplicateOf?.id, base.finding.id);
  const extraValidator = await ledger.addFinding(
    hordeDir, "R-meta", "member-5", "vendor alpha endpoint /api/v1/check leaks header X-Key",
    { concern: "vendor-check-authz", concernDef: "vendor check authz root cause and entry point" },
  );
  assert.equal(extraValidator.corroborationFull, true, "a second duplicate validator is redirected");
  assert.deepEqual(
    ledger.listFindingsForRun(hordeDir, "R-meta").find((finding) => finding.id === base.finding.id).corroborators,
    ["member-2"],
  );
  const delta = await ledger.addFinding(
    hordeDir, "R-meta", "member-3", "vendor alpha also exposes /api/v2/decision",
    { deltaOf: base.finding.id, concern: "vendor-check-authz", concernDef: "vendor check authz root cause and entry point" },
  );
  const separate = await ledger.addFinding(
    hordeDir, "R-meta", "member-4", "vendor alpha endpoint /api/v1/check leaks header X-Key",
    { concern: "oauth-login-state", concernDef: "oauth login state root cause and entry point" },
  );
  assert.equal(separate.duplicateOf, undefined, "different concerns do not deduplicate despite identical text");
  assert.equal(ledger.clusterFindings([base.finding, separate.finding]).length, 2, "different concerns stay separate");
  await assert.rejects(
    ledger.addFinding(hordeDir, "R-meta", "member-4", "unrelated OAuth route", {
      deltaOf: base.finding.id,
      concern: "oauth-login-state", concernDef: "oauth login state root cause and entry point",
    }),
    /exact concern/,
  );
  const clusters = ledger.clusterFindings(ledger.listFindingsForRun(hordeDir, "R-meta"));
  const cluster = clusters.find((c) => c.findings.some((f) => f.id === base.finding.id));
  assert.ok(cluster.members.includes("member-1"), "direct reporter is a member");
  assert.ok(cluster.members.includes("member-2"), "corroborator is a member");
  assert.ok(!cluster.members.includes("member-3"), "delta author must not count as agreement");
  assert.ok(cluster.deltaMembers.includes("member-3"), "delta author is listed separately");

  // Multiple references are permitted; explicit relation fields determine the parent.
  const multi = await ledger.addFinding(hordeDir, "R-meta", "member-4", `Compared F${delta.finding.id} with F${base.finding.id}: fresh evidence`, {
    deltaOf: base.finding.id,
    concern: "vendor-check-authz", concernDef: "vendor check authz root cause and entry point",
  });
  assert.equal(multi.finding.deltaOf, base.finding.id);
  // Naming the declared parent is fine.
  const ok = await ledger.addFinding(hordeDir, "R-meta", "member-4", `Delta on F${base.finding.id}: reproduced under PHP 8.2`, {
    deltaOf: base.finding.id,
    concern: "vendor-check-authz", concernDef: "vendor check authz root cause and entry point",
  });
  assert.equal(ok.finding.deltaOf, base.finding.id);

  // A correction phrased in the body must use supersedes, not delta.
  await ledger.appendRunHeading(hordeDir, "R-sup", "sup");
  const sbase = await ledger.addFinding(hordeDir, "R-sup", "member-1", "host alpha returns 200 on /probe");
  await assert.rejects(
    ledger.addFinding(hordeDir, "R-sup", "member-2", `Delta on F${sbase.finding.id}: correction to F${sbase.finding.id}`, { deltaOf: sbase.finding.id }),
    /supersedes: \d+/,
  );
  const sup = await ledger.addFinding(hordeDir, "R-sup", "member-2", `Correction to F${sbase.finding.id}: it returns 404`, { supersedes: sbase.finding.id });
  assert.equal(sup.finding.supersedes, sbase.finding.id);

  // The report prints the verification-first heading, delta list, usage label, and deliverable pointer.
  const report = prompt.runReportMarkdown({
    ...finalizingRun,
    outcome: "completed",
    findings: ledger.listFindingsForRun(hordeDir, "R-meta"),
    clusters: ledger.clusterFindings(ledger.listFindingsForRun(hordeDir, "R-meta")),
    claims: [],
    facts: [],
    deliverable: "# merged",
    lateBoardPosts: [{ runId: "R-meta", time: "12:00:00", author: "member-5", text: "XSS control was negative" }],
    consistencyWarnings: ["resource R2 path is missing: artifact.py"],
  });
  assert.match(report, /## Distinct findings \(ranked by review status, then legacy\/support ranking, then importance, then independent members\)/);
  assert.match(report, /deltas: member-3/);
  assert.match(report, /^Usage: /m);
  assert.match(report, /- deliverable: DELIVERABLE\.md/);
  assert.match(report, /## Late board posts retained from wind-down/);
  assert.match(report, /member-5: XSS control was negative/);
  assert.match(report, /## Consistency warnings/);
  assert.match(report, /resource R2 path is missing/);
  assert.match(report, /concern=vendor-check-authz/);

  fs.rmSync(cwd, { recursive: true, force: true });
  console.log("PASS: horde-finalizing-test");
  process.exit(0);
}
