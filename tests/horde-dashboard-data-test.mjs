import assert from "node:assert/strict";
import { createJiti, DEPS, PI } from "./harness.mjs";

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": PI,
    "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
    "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
    typebox: `${DEPS}/typebox/build/index.mjs`,
  },
});
const data = await jiti.import("../src/dashboard-data.ts");
import { buildHordeFixture } from "./fixtures.mjs";
const ledger = {
  ...(await jiti.import("../src/ledger/board.ts")),
  ...(await jiti.import("../src/ledger/clusters.ts")),
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/findings.ts")),
  ...(await jiti.import("../src/ledger/ideas.ts")),
};
const member = await jiti.import("../src/member.ts");

const HORDE = buildHordeFixture();
const RUN = "20260913-010341";
const idle = { hordeDir: HORDE, getActive: () => undefined };

const index = data.listRuns(idle);
assert.equal(index.activeId, undefined);
assert.deepEqual(index.runs.map((r) => r.id), [RUN, "20260913-010151"]);
assert.equal(index.runs[0].active, false);
assert.equal(index.runs[0].files.SUMMARY, true);
assert.equal(index.runs[0].files.REPORT, false);
assert.equal(index.runs[0].outcome, "finished");
assert.equal(index.runs[0].count, 3);
assert.equal(index.runs[0].model, "deepseek/deepseek-v4-flash");
assert.match(index.runs[0].prompt, /evaluate the implementation/);

const overview = data.loadRunOverview(idle, RUN);
assert.equal(overview.active, false);
assert.equal(overview.members.length, 3);
assert.ok(overview.members.every((m) => m.status === "done" && !m.live));
assert.equal(overview.members[0].name, "member-1");
assert.equal(overview.members[0].turns, 0, "legacy log has no turns line and no mapped session");
assert.equal(overview.members[0].sessionFile, undefined);
assert.equal(overview.unmappedSessions.length, 3);
assert.equal(overview.counts.done, 3);
assert.equal(overview.thinking, "medium");
assert.equal(overview.started, "2026-09-13 01:03:41");

const detail = data.loadMemberDetail(idle, RUN, "member-1");
assert.equal(detail.runId, RUN);
assert.equal(detail.logLines, 2);
assert.equal(detail.logTail.length, 2);
assert.match(detail.logTail[0], /^\[horde\] spawn/);
assert.equal(detail.lastText, undefined);
const log = data.loadMemberLog(idle, RUN, "member-1", 1);
assert.equal(log.lines.length, 1);
assert.equal(log.total, 2);
assert.equal(log.truncated, true);
assert.equal(data.loadMemberLog(idle, RUN, "member-1", 0).truncated, false);

const sessions = data.listRunSessions(idle, RUN);
assert.equal(sessions.files.length, 3);
assert.equal(sessions.files[0].member, undefined);
const flat = data.loadSessionTranscript(idle, RUN, sessions.files[0].name, "last", 5);
assert.equal(flat.entries.length, 5);
assert.equal(flat.hasMore, false);
const one = data.loadSessionEntry(idle, RUN, sessions.files[0].name, 3);
assert.equal(one.entry.index, 3);
assert.match(one.raw, /"type"/);

const task = data.loadRunFile(idle, RUN, "TASK");
assert.equal(task.present, true);
assert.match(task.content, /^# Horde run/);
assert.deepEqual(data.loadRunFile(idle, RUN, "REPORT"), {
  runId: RUN, name: "REPORT", present: false, content: "", bytes: 0, truncated: false,
});

const ideas = data.loadIdeas(idle);
const counts = ledger.countIdeas(ledger.parseIdeas(ledger.readHordeFile(HORDE, "ideas")));
assert.equal(ideas.open.length, counts.open);
assert.equal(ideas.inProgress.length, counts.inProgress);
assert.equal(ideas.done.length, counts.done);
assert.equal(ideas.ruledOut.length, counts.dead);
assert.ok(ideas.owners.length > 0);
const owned = data.loadIdeas(idle, ideas.owners[0]);
assert.ok(owned.done.every((idea) => idea.owner === ideas.owners[0]));

const posts = data.loadBoard(idle, RUN, "newest");
assert.ok(posts.entries.length > 0);
assert.ok(posts.entries.every((entry) => entry.runId === RUN));
assert.equal(posts.entries[0].author, ledger.listBoard(HORDE).at(-1).author);
assert.equal(data.loadBoard(idle, "all", "oldest").entries.length, ledger.listBoard(HORDE).length);

const findings = data.loadFindings(idle, RUN, "clusters", []);
const expected = ledger.clusterFindings(ledger.listFindingsForRun(HORDE, RUN));
assert.equal(findings.clusters.length, expected.length);
assert.equal(findings.findings.length, ledger.listFindingsForRun(HORDE, RUN).length);
assert.equal(data.loadFindings(idle, "all", "list", []).clusters, undefined);

const claims = data.loadClaims(idle);
assert.ok(Array.isArray(claims.groups));
const facts = data.loadFacts(idle, RUN);
assert.equal(facts.attribution, "unavailable");

// Synthetic active run with live member state.
const now = 1_000_000;
const mk = (i, patch) => Object.assign(member.newMemberState(i), { startedAt: now - 65_000 }, patch);
const live = {
  id: RUN, hordeDir: HORDE, runDir: `${HORDE}/runs/${RUN}`, prompt: "live prompt", count: 2,
  startedAt: now - 120_000, stopped: true, cleanStopUntil: now + 42_500, stopLabel: "stopped by user",
  startFactId: 0, model: "x/y", canary: "ok",
  members: [
    mk(1, { status: "running", currentTool: "bash", currentArg: "ls", turns: 3, toolCalls: 4 }),
    mk(2, { status: "done", turns: 5, endedAt: now - 5_000, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5 } }),
  ],
};
const activeSrc = { hordeDir: HORDE, getActive: () => live, now: () => now };
const liveOverview = data.loadRunOverview(activeSrc, RUN);
assert.equal(liveOverview.active, true);
assert.equal(liveOverview.outcome, "stopping");
assert.equal(liveOverview.cleanStop.secondsLeft, 43);
assert.equal(liveOverview.elapsedMs, 120_000);
assert.equal(liveOverview.members[0].activity, "bash: ls");
assert.equal(liveOverview.members[0].elapsedMs, 65_000);
assert.equal(liveOverview.members[1].elapsedMs, 60_000);
assert.equal(liveOverview.totals.cost, 0.5);
assert.equal(liveOverview.prompt, "live prompt");
assert.equal(liveOverview.thinking, "medium", "thinking still comes from TASK.md on disk");
assert.equal(data.listRuns(activeSrc).activeId, RUN);
assert.equal(data.listRuns(activeSrc).runs[0].outcome, "stopping");
const liveFacts = data.loadFacts(activeSrc, RUN);
assert.equal(liveFacts.attribution, "split");
assert.equal(liveFacts.carried.length, 0);
assert.equal(liveFacts.thisRun.length, liveFacts.all.length);
assert.throws(() => data.loadMemberDetail(activeSrc, RUN, "member-3"), /has no member-3/);
const gone = { ...activeSrc, getActive: () => ({ ...live, runDir: "/nonexistent/run" }) };
assert.equal(data.loadRunOverview(gone, RUN).runDirMissing, true);

// Validation and not-found paths.
const status = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof data.DashboardError, String(e)); return e.status; } assert.fail("expected throw"); };
assert.equal(status(() => data.loadRunOverview(idle, "../etc")), 400);
assert.equal(status(() => data.loadRunOverview(idle, "20991231-000000")), 404);
assert.equal(status(() => data.loadMemberDetail(idle, RUN, "member-99")), 400);
assert.equal(status(() => data.loadMemberDetail(idle, RUN, "member-9")), 404);
assert.equal(status(() => data.loadRunFile(idle, RUN, "passwd")), 400);
assert.equal(status(() => data.loadRunFile(idle, RUN, "../IDEAS")), 400);
assert.equal(status(() => data.loadTranscript(idle, RUN, "member-1", 0, 10)), 404);
assert.equal(status(() => data.loadSessionTranscript(idle, RUN, "../../IDEAS.md", 0, 1)), 400);
assert.equal(status(() => data.loadSessionTranscript(idle, RUN, "nope.jsonl", 0, 1)), 404);
assert.equal(status(() => data.loadSessionEntry(idle, RUN, sessions.files[0].name, 999999)), 404);
assert.equal(status(() => data.loadIdeas(idle, "member-99")), 400);
assert.equal(status(() => data.loadBoard(idle, "x", "newest")), 400);
assert.equal(status(() => data.loadFacts(idle, "bad")), 400);
console.log("PASS: horde-dashboard-data-test");
