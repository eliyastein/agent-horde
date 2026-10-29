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
  // The "stall" scenario: member-2 completes without touching its inbox; member-3 defers member-2's
  // blocker on its sender's behalf, so that one held thread changes and re-qualifies member-2.
  const stalling = process.env.PI_HORDE_FIXTURE_REPAIR === "stall" && ctx.actor === "member-2";
  if (process.env.PI_HORDE_FIXTURE_REPAIR === "stall" && ctx.actor === "member-3") {
    const blocker = collaborationState(ctx.hordeDir, ctx.runId).messages.find((m) => m.kind === "blocker" && m.to === "member-2" && m.state !== "deferred");
    if (blocker) await runCollaborationAction({ ...ctx, actor: blocker.sender }, { action: "defer", target: blocker.id, text: "parked while the owner reworks it" });
  }
  for (const q of stalling ? [] : inboxFor(ctx)) {
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
  const input = Number(process.env.PI_HORDE_FIXTURE_REPAIR_USAGE ?? 10);
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "repair complete" }], stopReason: "stop", usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\n");
} else {
  const { initHordeDir } = await jiti.import("../src/ledger/files.ts");
  const { drainRepairs, repairAllowance, repairBudget, repairShare, repairTimeShare } = await jiti.import("../src/run/repair.ts");
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
    const scenarios = [
      { index: 1, scenario: "greedy", kind: "blocker", stop: "tokens" },
      { index: 2, scenario: "greedy", kind: "question", stop: "tokens" },
      { index: 3, scenario: "hang", kind: "blocker", stop: "time" },
      // A greedy owner under a turn cap is stopped by turns before its tokens run out.
      { index: 4, scenario: "greedy", kind: "blocker", stop: "turns" },
    ];
    for (const { index, scenario, kind, stop } of scenarios) {
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
      process.env.PI_HORDE_REPAIR_TOKENS = stop === "tokens" ? "300" : "50000";
      process.env.PI_HORDE_REPAIR_MS = scenario === "hang" ? "4000" : "20000";
      process.env.PI_HORDE_REPAIR_ROUNDS = scenario === "hang" ? "1" : "2";
      process.env.PI_HORDE_REPAIR_MIN_TOKENS = "1";
      process.env.PI_HORDE_REPAIR_MIN_MS = "1";
      process.env.PI_HORDE_REPAIR_TURNS = stop === "turns" ? "3" : "40";
      await drainRepairs({ ...launch, run: caseRun, roles: Array(6).fill("fixture") });
      const events = readEvents(hordeDir, caseId);
      const starts = events.filter((e) => e.action === "repair-start");
      const ends = events.filter((e) => e.action === "repair-end");
      assert.equal(starts[0].actor, kind === "question" ? "member-6" : "member-1", "artifact reviews outrank administrative questions; blockers retain priority");
      const caseReviews = collaborationState(hordeDir, caseId).reviews;
      assert.equal(caseReviews.filter((r) => r.actor !== "member-1").length, 7, "all seven queued artifact reviews ran despite greedy/hung owner");
      assert.ok(new Set(caseReviews.map((r) => r.actor)).size > 1, "reviews spread across non-owners instead of queuing on the verifier");
      assert.equal(caseMembers[0].repairStopReason, stop);
      const ownerEnd = ends.find((e) => e.actor === "member-1" && e.payload.stopReason === stop);
      assert.ok(ownerEnd, "stop attribution is persisted independently from generic process kill");
      assert.ok(starts[0].payload.allowance.tokens < Number(process.env.PI_HORDE_REPAIR_TOKENS));
      assert.equal(starts[0].payload.allowance.turns, Number(process.env.PI_HORDE_REPAIR_TURNS), "the turn cap is recorded with the attempt");
      assert.ok(caseMembers[0].usage.input >= 50_332, "discovery usage survives bounded repair attempts");
      if (stop === "tokens") assert.ok(caseRun.repairTokens < 360, "budget excludes prior discovery usage; overshoot is at most one reported 60-token message");
      if (stop === "turns") assert.ok(ownerEnd.payload.turns >= 3 && ownerEnd.payload.turns < 40, `the owner was stopped at the turn cap, not the token cap: ${ownerEnd.payload.turns} turns`);
    }
  } finally {
    for (const key of ["PI_HORDE_FIXTURE_REPAIR", "PI_HORDE_REPAIR_TOKENS", "PI_HORDE_REPAIR_MS", "PI_HORDE_REPAIR_ROUNDS", "PI_HORDE_REPAIR_MIN_TOKENS", "PI_HORDE_REPAIR_MIN_MS", "PI_HORDE_REPAIR_TURNS"]) {
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

  // The clock is split among the attempts the token budget can fund, never below the time floor.
  // With the defaults, 50k tokens at a 20k floor fund two attempts, so four queued members get
  // 60 s each instead of 120 s / (4 + 2) = 20 s.
  assert.equal(repairTimeShare(120_000, 4, 3, 2), 60_000);
  assert.equal(repairTimeShare(120_000, 1, 3, 2), 60_000, "one pending member still shares with one reserved recheck");
  assert.equal(repairTimeShare(120_000, 6, 1, 300), 17_142, "a generous token budget falls back to the member/round reservation");
  assert.equal(repairAllowance(59_000, 119_000, 60_000), 60_000, "a share just under the floor is raised to it");
  assert.equal(repairAllowance(20_000, 30_000, 60_000), undefined, "a clock that cannot pay one floor funds nothing");
  const queued = async (runId, memberCount) => {
    const dir = path.join(hordeDir, "runs", runId);
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "TASK.md"), `Members: ${memberCount}\n`);
    fs.writeFileSync(path.join(dir, "SYSTEM.md"), "fixture");
    fs.writeFileSync(path.join(dir, "artifacts/probe.txt"), "fixed: positive and negative controls\n");
    const subject = JSON.parse((await runCollaborationAction({ hordeDir, runId, actor: "member-1" }, { action: "artifact", artifactPath: "artifacts/probe.txt", criteria: "positive and negative controls" })).text).artifact;
    for (let n = 2; n <= memberCount; n++) {
      await runCollaborationAction({ hordeDir, runId, actor: "member-1" }, { action: "message", target: subject.id, to: `member-${n}`, kind: "question", text: `please look at ${subject.id}` });
    }
    const queuedMembers = Array.from({ length: memberCount }, (_, i) => Object.assign(newMemberState(i + 1), { status: "done", endCause: "completed" }));
    return { ...run, id: runId, runDir: dir, members: queuedMembers, count: memberCount, verifier: `member-${memberCount}`, repairTokens: 0, repairSkipped: undefined, controller: new AbortController(), controllers: new Map(), procs: new Map() };
  };
  const budgetEnv = { ...process.env };
  try {
    process.env.PI_HORDE_REPAIR_ROUNDS = "1";
    const fourRun = await queued("20261018-120001", 5);
    await drainRepairs({ ...launch, run: fourRun, roles: Array(5).fill("fixture") });
    const fourStarts = readEvents(hordeDir, fourRun.id).filter((e) => e.action === "repair-start");
    assert.equal(fourStarts.length, 4, "every queued member was served");
    assert.ok(fourStarts.every((e) => e.payload.allowance.ms >= 60_000), `no attempt below the time floor: ${fourStarts.map((e) => e.payload.allowance.ms).join(", ")}`);
    assert.deepEqual(fourStarts[0].payload.floors, { tokens: 40_000, ms: 60_000 }, "the floors in force are recorded with the attempt");
    assert.equal(fourRun.repairSkipped, undefined);

    process.env.PI_HORDE_REPAIR_MS = "30000";
    const shortRun = await queued("20261018-120002", 5);
    await drainRepairs({ ...launch, run: shortRun, roles: Array(5).fill("fixture") });
    const shortEvents = readEvents(hordeDir, shortRun.id);
    assert.equal(shortEvents.filter((e) => e.action === "repair-start").length, 0, "a clock below the floor spawns no doomed attempt");
    const shortSkip = shortEvents.find((e) => e.action === "repair-skipped");
    assert.equal(shortSkip.payload.reason, "insufficient-time");
    assert.equal(shortSkip.payload.floorMs, 60_000);
    assert.deepEqual(shortSkip.payload.members.map((m) => m.member).sort(), ["member-2", "member-3", "member-4", "member-5"]);
    assert.deepEqual(shortRun.repairSkipped.sort(), ["member-2", "member-3", "member-4", "member-5"], "the summary learns who went unserved");
  } finally {
    for (const key of ["PI_HORDE_REPAIR_ROUNDS", "PI_HORDE_REPAIR_MS"]) {
      if (budgetEnv[key] === undefined) delete process.env[key]; else process.env[key] = budgetEnv[key];
    }
  }

  // The default totals follow the queues, one floor per demand unit up to six, so attempts that
  // each cost about a floor all start. The former flat 50k total served one such attempt.
  const floors = { tokens: 40_000, ms: 60_000 };
  assert.deepEqual(repairBudget([1, 1, 1, 1], floors, 1), { tokens: 160_000, ms: 240_000, turns: 40, queued: 4 });
  assert.deepEqual(repairBudget([1, 1, 1, 1], floors, 4), { tokens: 240_000, ms: 360_000, turns: 40, queued: 4 }, "later rounds reserve two correction/recheck floors");
  assert.deepEqual(repairBudget([3, 1], floors, 1), { tokens: 160_000, ms: 240_000, turns: 40, queued: 2 }, "a three-review queue is funded as three units");
  assert.equal(repairBudget(Array(8).fill(1), floors, 1).tokens, 240_000, "the default funds at most six units");
  assert.equal(repairBudget([], floors, 1).ms, 60_000, "an empty queue still names one floor");
  const costEnv = { ...process.env };
  try {
    process.env.PI_HORDE_REPAIR_ROUNDS = "1";
    process.env.PI_HORDE_FIXTURE_REPAIR_USAGE = "39000";
    const costlyRun = await queued("20261018-120003", 5);
    await drainRepairs({ ...launch, run: costlyRun, roles: Array(5).fill("fixture") });
    const costlyEvents = readEvents(hordeDir, costlyRun.id);
    assert.equal(costlyEvents.filter((e) => e.action === "repair-start").length, 4, "four attempts that each cost a floor all start");
    assert.equal(costlyRun.repairSkipped, undefined);
    const phase = costlyEvents.find((e) => e.action === "phase-start" && e.payload.phase === "repair");
    assert.deepEqual(phase.payload.budget, { tokens: 160_000, ms: 240_000, turns: 40, queued: 4 }, "the budget in force is recorded with the phase");
    const costlyEnd = costlyEvents.find((e) => e.action === "repair-end");
    assert.equal(costlyEnd.payload.turns, 1);
    assert.deepEqual(costlyEnd.payload.firstTurn, { turns: 1, input: 39_000, output: 5, cacheRead: 0, cacheWrite: 0 }, "the first-turn cost is recorded so the floor can be tuned from data");

    process.env.PI_HORDE_REPAIR_TOKENS = "50000";
    process.env.PI_HORDE_REPAIR_MIN_TOKENS = "20000";
    const flatRun = await queued("20261018-120004", 5);
    await drainRepairs({ ...launch, run: flatRun, roles: Array(5).fill("fixture") });
    assert.equal(readEvents(hordeDir, flatRun.id).filter((e) => e.action === "repair-start").length, 1, "a flat 50k total funds one attempt that costs 39k");
    assert.deepEqual(flatRun.repairSkipped.sort(), ["member-2", "member-3", "member-4"], "the assigned artifact review went first; the questions were skipped");
  } finally {
    for (const key of ["PI_HORDE_REPAIR_ROUNDS", "PI_HORDE_FIXTURE_REPAIR_USAGE", "PI_HORDE_REPAIR_TOKENS", "PI_HORDE_REPAIR_MIN_TOKENS"]) {
      if (costEnv[key] === undefined) delete process.env[key]; else process.env[key] = costEnv[key];
    }
  }

  // The order is re-read before each attempt: a blocking challenge raised during the reviewer's
  // attempt sends its recipient ahead of a member whose queue is a question, within the same round.
  const orderId = "20261019-500004";
  const orderDir = path.join(hordeDir, "runs", orderId);
  fs.mkdirSync(path.join(orderDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(orderDir, "TASK.md"), "Members: 3\n");
  fs.writeFileSync(path.join(orderDir, "SYSTEM.md"), "fixture");
  fs.writeFileSync(path.join(orderDir, "artifacts/scanner.txt"), "broken: negative=tracker\n");
  const orderArtifact = JSON.parse((await runCollaborationAction({ hordeDir, runId: orderId, actor: "member-1" }, { action: "artifact", artifactPath: "artifacts/scanner.txt", criteria: "negative unknown; positive tracker" })).text).artifact;
  await runCollaborationAction({ hordeDir, runId: orderId, actor: "member-1" }, { action: "message", target: orderArtifact.id, to: "member-3", kind: "question", text: "is the control set complete?" });
  const orderMembers = [1, 2, 3].map((n) => Object.assign(newMemberState(n), { status: "done", endCause: "completed" }));
  const orderRun = { ...run, id: orderId, runDir: orderDir, members: orderMembers, count: 3, verifier: "member-2", repairTokens: 0, repairSkipped: undefined, controller: new AbortController(), controllers: new Map(), procs: new Map() };
  const orderEnv = { ...process.env };
  try {
    process.env.PI_HORDE_REPAIR_ROUNDS = "1";
    await drainRepairs({ ...launch, run: orderRun, roles: Array(3).fill("fixture") });
  } finally {
    if (orderEnv.PI_HORDE_REPAIR_ROUNDS === undefined) delete process.env.PI_HORDE_REPAIR_ROUNDS; else process.env.PI_HORDE_REPAIR_ROUNDS = orderEnv.PI_HORDE_REPAIR_ROUNDS;
  }
  const orderStarts = readEvents(hordeDir, orderId).filter((e) => e.action === "repair-start").map((e) => e.actor);
  assert.deepEqual(orderStarts, ["member-2", "member-1", "member-3"], "the owner's new blocker is served before the pending question, in the single round");
  assert.ok(collaborationState(hordeDir, orderId).messages.some((m) => m.kind === "challenge" && m.to === "member-1" && m.state === "responded"), "the owner answered the challenge raised mid-round");

  // A thread that a completed attempt left unchanged is held back from that member in later rounds
  // (issue #28): member-2 ignores its blocker, member-3 answers nothing on its question. Only the
  // deferral of the blocker, a change by another member, earns member-2 a second attempt.
  const stallId = "20261028-300001";
  const stallDir = path.join(hordeDir, "runs", stallId);
  fs.mkdirSync(path.join(stallDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(stallDir, "TASK.md"), "Members: 3\n");
  fs.writeFileSync(path.join(stallDir, "SYSTEM.md"), "fixture");
  fs.writeFileSync(path.join(stallDir, "artifacts/probe.txt"), "fixed: positive and negative controls\n");
  const stallArtifact = JSON.parse((await runCollaborationAction({ hordeDir, runId: stallId, actor: "member-1" }, { action: "artifact", artifactPath: "artifacts/probe.txt", criteria: "positive and negative controls" })).text).artifact;
  const stallBlocker = JSON.parse((await runCollaborationAction({ hordeDir, runId: stallId, actor: "member-1" }, { action: "message", target: stallArtifact.id, to: "member-2", kind: "blocker", text: "rerun the negative control" })).text).message;
  const stallQuestion = JSON.parse((await runCollaborationAction({ hordeDir, runId: stallId, actor: "member-1" }, { action: "message", target: stallArtifact.id, to: "member-3", kind: "question", text: "is the control set complete?" })).text).message;
  const stallMembers = [1, 2, 3].map((n) => Object.assign(newMemberState(n), { status: "done", endCause: "completed" }));
  const stallRun = { ...run, id: stallId, runDir: stallDir, members: stallMembers, count: 3, verifier: "member-3", repairTokens: 0, repairSkipped: undefined, controller: new AbortController(), controllers: new Map(), procs: new Map() };
  const stallEnv = { ...process.env };
  try {
    process.env.PI_HORDE_FIXTURE_REPAIR = "stall";
    process.env.PI_HORDE_REPAIR_ROUNDS = "3";
    process.env.PI_HORDE_REPAIR_TOKENS = "50000";
    process.env.PI_HORDE_REPAIR_MS = "90000";
    process.env.PI_HORDE_REPAIR_MIN_TOKENS = "1";
    process.env.PI_HORDE_REPAIR_MIN_MS = "1";
    await drainRepairs({ ...launch, run: stallRun, roles: Array(3).fill("fixture") });
  } finally {
    for (const key of ["PI_HORDE_FIXTURE_REPAIR", "PI_HORDE_REPAIR_ROUNDS", "PI_HORDE_REPAIR_TOKENS", "PI_HORDE_REPAIR_MS", "PI_HORDE_REPAIR_MIN_TOKENS", "PI_HORDE_REPAIR_MIN_MS"]) {
      if (stallEnv[key] === undefined) delete process.env[key]; else process.env[key] = stallEnv[key];
    }
  }
  const stallEvents = readEvents(hordeDir, stallId);
  const stallStarts = stallEvents.filter((e) => e.action === "repair-start");
  assert.deepEqual(stallStarts.map((e) => e.actor), ["member-2", "member-3", "member-2"], "three rounds, three attempts: the unchanged question is never retried, the blocker only after its deferral");
  assert.deepEqual(stallStarts[2].payload.messages, [stallBlocker.id], "the deferred blocker re-qualified member-2 on its own");
  assert.equal(collaborationState(hordeDir, stallId).messages.find((m) => m.id === stallBlocker.id).state, "deferred");
  const stallEnds = stallEvents.filter((e) => e.action === "repair-end");
  assert.deepEqual(stallEnds.filter((e) => e.actor === "member-2").map((e) => e.payload.unchanged), [[stallBlocker.id], [stallBlocker.id]], "each completed attempt records what it left unchanged");
  assert.ok(stallEnds.find((e) => e.actor === "member-3").payload.unchanged.includes(stallQuestion.id), "member-3 reviewed the artifact but never answered the question");
  const stalls = stallEvents.filter((e) => e.action === "repair-skipped" && e.payload.reason === "no-progress");
  assert.deepEqual(stalls.map((e) => e.payload.members[0].member), ["member-2", "member-3", "member-2"], "a member whose whole queue is held is recorded as stalled");
  assert.deepEqual(stalls[0].payload.members[0].messages, [stallBlocker.id]);
  assert.deepEqual(stallRun.repairStalled, ["member-2", "member-3"], "the summary learns who stalled");
  assert.equal(stallMembers[1].repairs, 2);
  assert.equal(stallMembers[2].repairs, 1);

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
