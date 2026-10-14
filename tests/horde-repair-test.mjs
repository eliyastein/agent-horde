import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  "@earendil-works/pi-coding-agent": PI,
  "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
  "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
  typebox: `${DEPS}/typebox/build/index.mjs`,
} });
const { runCollaborationAction } = await jiti.import("../src/tool/collaboration-actions.ts");
const { inboxFor } = await jiti.import("../src/tool/inbox.ts");
const { collaborationState } = await jiti.import("../src/ledger/collaboration.ts");

if (process.argv.includes("--mode")) {
  const ctx = { hordeDir: process.env.PI_HORDE_DIR, runId: process.env.PI_HORDE_RUN, actor: process.env.PI_HORDE_NAME, attempt: process.env.PI_HORDE_ATTEMPT };
  const act = async (params) => JSON.parse((await runCollaborationAction(ctx, params)).text);
  if (process.env.PI_HORDE_FIXTURE_REPAIR && ctx.actor === "member-1") {
    setInterval(() => {
      if (process.env.PI_HORDE_FIXTURE_REPAIR === "hang") return;
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "busy repair" }], stopReason: "stop", usage: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\n");
    }, 25);
    await new Promise(() => {});
  }
  for (const q of inboxFor(ctx)) {
    const artifact = collaborationState(ctx.hordeDir, ctx.runId).artifacts.find((a) => a.id === q.target);
    if (ctx.actor === artifact.owner) {
      await act({ action: "ack", target: q.id, text: "fixing the scanner" });
      fs.writeFileSync(path.join(ctx.hordeDir, "runs", ctx.runId, artifact.path), "fixed: negative=unknown; positive=tracker\n");
      const next = (await act({ action: "artifact", target: artifact.id, revision: artifact.hash, artifactPath: artifact.path, criteria: "negative unknown; positive tracker" })).artifact;
      await act({ action: "respond", target: q.id, revision: next.hash, text: "published repaired scanner" });
    } else {
      const fixed = fs.readFileSync(path.join(ctx.hordeDir, "runs", ctx.runId, artifact.path), "utf8").startsWith("fixed:");
      const evidence = (await act({ action: "attach", target: artifact.id, relation: fixed ? "supports" : "contradicts", text: fixed ? "both controls pass" : "negative control fails" })).evidenceRecord;
      await act({ action: "review", target: artifact.id, revision: artifact.hash, verdict: fixed ? "supports" : "refutes", support: "tested", checked: "two deterministic controls", unchecked: "", refs: [evidence.id], text: "fixture review" });
      if (q.state === "responded" && fixed) await act({ action: "resolve", target: q.id, refs: [evidence.id], text: "retest passed" });
    }
  }
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "repair complete" }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\n");
} else {
  const { initHordeDir } = await jiti.import("../src/ledger/files.ts");
  const { drainRepairs, repairShare } = await jiti.import("../src/run/repair.ts");
  const { readEvents } = await jiti.import("../src/ledger/events.ts");
  const { newMemberState } = await jiti.import("../src/member.ts");
  const { loadCollaborationReport } = await jiti.import("../src/collaboration-report.ts");
  fs.mkdirSync(".tmp", { recursive: true });
  const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-repair-"));
  const hordeDir = initHordeDir(cwd);
  const id = "20260925-191813";
  const runDir = path.join(hordeDir, "runs", id);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 2\n");
  fs.writeFileSync(path.join(runDir, "SYSTEM.md"), "fixture");
  fs.writeFileSync(path.join(runDir, "artifacts/scanner.txt"), "broken: negative=tracker\n");
  const artifact = JSON.parse((await runCollaborationAction({ hordeDir, runId: id, actor: "member-1" }, { action: "artifact", artifactPath: "artifacts/scanner.txt", criteria: "negative unknown; positive tracker" })).text).artifact;
  const members = [1, 2].map((n) => Object.assign(newMemberState(n), { status: "done", endCause: "completed", turns: 2, toolCalls: 1 }));
  const run = { id, runDir, hordeDir, count: 2, cwd, prompt: "repair fixture", members, stopped: false, startedAt: Date.now(), cleanStopNames: [], controllers: new Map(), procs: new Map(), controller: new AbortController(), verifier: "member-2" };
  const launch = { run, state: { disposed: false }, roles: ["owner", "review"], ctx: { cwd, hasUI: false, isProjectTrusted: () => true } };
  await drainRepairs(launch);
  assert.equal(members[0].repairs, 1, "completed owner was restarted for repair");
  assert.equal(members[1].repairs, 2, "reviewer was restarted for initial and revised review");
  assert.equal(run.repairTokens, 45);
  assert.equal(members[0].turns, 3, "prior usage/turns preserved");
  const report = loadCollaborationReport(hordeDir, id);
  assert.deepEqual(report.acceptedArtifacts, [artifact.id]);
  assert.equal(report.metrics.resolvedChallenges, 1);
  assert.equal(report.metrics.blocking, 0);
  assert.match(fs.readFileSync(path.join(runDir, "member-1.log"), "utf8"), /Repair attempt 1/);
  const firstStarts = readEvents(hordeDir, id).filter((e) => e.action === "repair-start");
  assert.ok(firstStarts.every((e) => e.payload.allowance.tokens >= 20_000), "each attempt can afford a cold first turn");

  // A greedy or hung member-1 must leave an opportunity for member-6's seven reviews.
  assert.equal(repairShare(50_000, 2, 3), 12_500);
  assert.equal(repairShare(0, 2, 3), 0);
  const savedEnv = { ...process.env };
  try {
    for (const [index, scenario, kind] of [[1, "greedy", "blocker"], [2, "greedy", "question"], [3, "hang", "blocker"]]) {
      const caseId = `20260928-20403${index}`;
      const caseDir = path.join(hordeDir, "runs", caseId);
      fs.mkdirSync(path.join(caseDir, "artifacts"), { recursive: true });
      fs.writeFileSync(path.join(caseDir, "TASK.md"), "Members: 6\n");
      fs.writeFileSync(path.join(caseDir, "SYSTEM.md"), "fixture");
      const subjects = [];
      for (let n = 0; n < 7; n++) {
        const artifactPath = `artifacts/control-${n}.txt`;
        fs.writeFileSync(path.join(caseDir, artifactPath), "fixed: positive and negative controls\n");
        subjects.push(JSON.parse((await runCollaborationAction({ hordeDir, runId: caseId, actor: "member-1" }, { action: "artifact", artifactPath, criteria: "positive and negative controls" })).text).artifact);
      }
      await runCollaborationAction({ hordeDir, runId: caseId, actor: "member-6" }, { action: "message", target: subjects[0].id, to: "member-1", kind, text: "pending owner work" });
      const caseMembers = [1, 2, 3, 4, 5, 6].map((n) => Object.assign(newMemberState(n), { status: "done", endCause: "completed", turns: 101 }));
      caseMembers[0].usage.input = 50_332;
      const caseRun = { ...run, id: caseId, runDir: caseDir, members: caseMembers, count: 6, verifier: "member-6", repairTokens: 0, controller: new AbortController(), controllers: new Map(), procs: new Map() };
      process.env.PI_HORDE_FIXTURE_REPAIR = scenario;
      process.env.PI_HORDE_REPAIR_TOKENS = scenario === "hang" ? "50000" : "300";
      process.env.PI_HORDE_REPAIR_MS = scenario === "hang" ? "4000" : "20000";
      process.env.PI_HORDE_REPAIR_ROUNDS = scenario === "hang" ? "1" : "2";
      process.env.PI_HORDE_REPAIR_MIN_TOKENS = "1";
      await drainRepairs({ ...launch, run: caseRun, roles: Array(6).fill("fixture") });
      const events = readEvents(hordeDir, caseId);
      const starts = events.filter((e) => e.action === "repair-start");
      const ends = events.filter((e) => e.action === "repair-end");
      assert.equal(starts[0].actor, kind === "question" ? "member-6" : "member-1", "artifact reviews outrank administrative questions; blockers retain priority");
      const caseReviews = collaborationState(hordeDir, caseId).reviews;
      assert.equal(caseReviews.filter((r) => r.actor !== "member-1").length, 7, "all seven queued artifact reviews ran despite greedy/hung owner");
      assert.ok(new Set(caseReviews.map((r) => r.actor)).size > 1, "reviews spread across non-owners instead of queuing on the verifier");
      assert.equal(caseMembers[0].repairStopReason, scenario === "hang" ? "time" : "tokens");
      assert.ok(ends.some((e) => e.actor === "member-1" && e.payload.stopReason === caseMembers[0].repairStopReason), "stop attribution is persisted independently from generic process kill");
      assert.ok(starts[0].payload.allowance.tokens < Number(process.env.PI_HORDE_REPAIR_TOKENS));
      assert.ok(caseMembers[0].usage.input >= 50_332, "discovery usage survives bounded repair attempts");
      assert.ok(caseRun.repairTokens < 360, "budget excludes prior discovery usage; overshoot is at most one reported 60-token message");
    }
  } finally {
    for (const key of ["PI_HORDE_FIXTURE_REPAIR", "PI_HORDE_REPAIR_TOKENS", "PI_HORDE_REPAIR_MS", "PI_HORDE_REPAIR_ROUNDS", "PI_HORDE_REPAIR_MIN_TOKENS"]) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }

  // A budget that cannot pay for one cold turn records the unserved work instead of spawning a doomed attempt.
  const poorId = "20261005-231100";
  const poorDir = path.join(hordeDir, "runs", poorId);
  fs.mkdirSync(path.join(poorDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(poorDir, "artifacts/note.md"), "draft\n");
  const poorArtifact = JSON.parse((await runCollaborationAction({ hordeDir, runId: poorId, actor: "member-1" }, { action: "artifact", artifactPath: "artifacts/note.md", artifactKind: "document", criteria: "accurate" })).text).artifact;
  const poorMembers = [1, 2].map((n) => Object.assign(newMemberState(n), { status: "done", endCause: "completed" }));
  const poorRun = { ...run, id: poorId, runDir: poorDir, members: poorMembers, repairTokens: 0, controller: new AbortController(), controllers: new Map(), procs: new Map() };
  process.env.PI_HORDE_REPAIR_TOKENS = "15000";
  try {
    await drainRepairs({ ...launch, run: poorRun });
  } finally {
    if (savedEnv.PI_HORDE_REPAIR_TOKENS === undefined) delete process.env.PI_HORDE_REPAIR_TOKENS; else process.env.PI_HORDE_REPAIR_TOKENS = savedEnv.PI_HORDE_REPAIR_TOKENS;
  }
  const poorEvents = readEvents(hordeDir, poorId);
  assert.equal(poorEvents.filter((e) => e.action === "repair-start").length, 0, "no attempt below the floor");
  const skipped = poorEvents.find((e) => e.action === "repair-skipped");
  assert.ok(skipped, "unserved repair work is recorded");
  assert.equal(skipped.payload.reason, "insufficient-budget");
  assert.deepEqual(skipped.payload.members.map((m) => m.member), ["member-2"]);
  assert.ok(collaborationState(hordeDir, poorId).messages.some((m) => skipped.payload.members[0].messages.includes(m.id) && m.target === poorArtifact.id));
  assert.equal(poorMembers[1].repairs, undefined);

  // Hard stops never schedule repair sessions, even with work pending.
  await runCollaborationAction({ hordeDir, runId: id, actor: "member-2" }, { action: "message", target: artifact.id, kind: "challenge", text: "new unresolved issue" });
  run.stopped = true;
  await drainRepairs(launch);
  assert.equal(members[0].repairs, 1);
  assert.equal(loadCollaborationReport(hordeDir, id).metrics.blocking, 1);
  run.stopped = false;
  run.userStop = true;
  await drainRepairs(launch);
  assert.equal(members[0].repairs, 1, "explicit user-stop authority is preserved independently of stopped flag");
  run.userStop = false;
  run.controller.abort();
  await drainRepairs(launch);
  assert.equal(members[0].repairs, 1, "an aborted parent cannot start repairs");
  console.log(`PASS: horde-repair-test (fixtures retained in ${cwd})`);
}
