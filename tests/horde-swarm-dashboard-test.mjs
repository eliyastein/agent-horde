// The dashboard reads a swarm's hordes from their own directories under .horde/swarms/<id>/hN/:
// the index lists swarms and tags their runs, run pages resolve swarm run ids, the ledger pages
// read a horde's ledgers through ?run=, and /swarms/<id> has one row per horde plus a graph with
// one lane per horde and the merge step. Built on a synthetic swarm written through the parent's
// own layout and event code, so nothing machine-specific is checked in.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
const files = await jiti.import("../src/ledger/files.ts");
const swarmMod = await jiti.import("../src/run/swarm.ts");
const events = await jiti.import("../src/ledger/events.ts");
const facts = await jiti.import("../src/ledger/facts.ts");
const prompt = await jiti.import("../src/prompt.ts");
const data = await jiti.import("../src/dashboard-data.ts");
const dashboard = await jiti.import("../src/dashboard.ts");
const graphMod = await jiti.import("../src/swarm-graph.ts");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-swarm-dash-"));
const hordeDir = files.initHordeDir(cwd);
const startedAt = Date.parse("2026-10-24T10:00:00Z");
const layout = swarmMod.allocateSwarm(hordeDir, 2, startedAt);
assert.equal(layout.runIds.length, 2);
assert.match(layout.runIds[0], /^\d{8}-\d{6}-h1$/);
assert.equal(layout.dir, path.join(hordeDir, "swarms", layout.id));
assert.ok(fs.existsSync(path.join(layout.hordeDirs[1], "IDEAS.md")));
// A second swarm in the same second gets a suffixed id; a plain run too.
const again = swarmMod.allocateSwarm(hordeDir, 2, startedAt);
assert.equal(again.id, `${layout.id}-1`);
const plain = swarmMod.allocateSwarm(hordeDir, 1, startedAt);
assert.equal(plain.id, layout.id, "a swarm of one allocates under runs/, where the id is still free");
assert.equal(plain.dir, undefined);
assert.deepEqual(plain.hordeDirs, [hordeDir]);
fs.rmSync(again.dir, { recursive: true });
fs.rmSync(plain.runDirs[0], { recursive: true });

const lifecycle = { actor: "parent", attempt: "lifecycle" };
const record = async (index, action, payload) =>
  events.recordEvent({ hordeDir: layout.hordeDirs[index], runId: layout.runIds[index], ...lifecycle }, action, { payload });
for (const [index, runId] of layout.runIds.entries()) {
  const runDir = layout.runDirs[index];
  fs.writeFileSync(path.join(runDir, "TASK.md"), prompt.taskMarkdown({
    id: runId, prompt: "split task", count: 1, startedAt, swarm: { id: layout.id, horde: index + 1, hordes: 2, slice: `slice ${index + 1}` },
  }));
  fs.writeFileSync(path.join(runDir, "member-1.log"), "[horde] spawn: pi\n[horde] exit code 0 status done cause completed\n[horde] turns 3 toolCalls 2\n");
  fs.writeFileSync(path.join(runDir, "REPORT.md"), `# Horde run ${runId}\n\n- outcome: completed\n`);
  await record(index, "run-start", { count: 1, swarm: layout.id, horde: index + 1, hordes: 2, slice: `slice ${index + 1}` });
  await record(index, "phase-start", { phase: "discovery" });
  await record(index, "phase-end", { phase: "discovery" });
  await record(index, "run-end", { outcome: "completed" });
}
await facts.addFact(layout.hordeDirs[1], "member-1", "a fact only h2 knows");
fs.writeFileSync(path.join(layout.dir, "SWARM.md"), "# Swarm\n");
fs.writeFileSync(path.join(layout.dir, "REPORT.md"), "# Swarm report\n");
fs.writeFileSync(path.join(layout.dir, "SWARM.json"), JSON.stringify({
  id: layout.id, prompt: "split task", hordes: 2, count: 1, startedAt, untilStop: false, partition: ["slice 1", "slice 2"],
  runs: layout.runIds.map((runId, i) => ({ label: `h${i + 1}`, runId, runDir: layout.runDirs[i], hordeDir: layout.hordeDirs[i], startedAt, outcome: "completed" })),
  merge: { startedAt: startedAt + 60_000, endedAt: startedAt + 90_000, written: false },
  endedAt: startedAt + 90_000,
}));

const src = { hordeDir, getActive: () => [] };
const get = (pathname) => dashboard.routeRequest(src, "GET", new URL(`http://127.0.0.1:7433${pathname}`), "127.0.0.1:7433");
const json = (pathname) => JSON.parse(get(`/api${pathname}`).body);

// ---- id helpers ---------------------------------------------------------------
assert.deepEqual(data.swarmOfRun(layout.runIds[1]), { swarmId: layout.id, horde: 2 });
assert.equal(data.swarmOfRun(layout.id), undefined);
assert.ok(data.RUN_ID_RE.test(layout.runIds[0]));
assert.ok(!data.RUN_ID_RE.test(`${layout.id}-h`));
assert.equal(data.ledgerDir(src, layout.runIds[1]), layout.hordeDirs[1]);
assert.equal(data.ledgerDir(src, layout.id), hordeDir);

// ---- index: swarms and their runs -------------------------------------------
const index = json("/");
assert.equal(index.swarms.length, 1);
assert.equal(index.swarms[0].id, layout.id);
assert.equal(index.swarms[0].hordes, 2);
assert.deepEqual(index.swarms[0].outcomes, ["completed", "completed"]);
assert.deepEqual(index.swarms[0].files, { SWARM: true, REPORT: true, DELIVERABLE: false });
assert.deepEqual(index.runs.map((r) => r.id).sort(), [...layout.runIds].sort(), "swarm runs are listed without a plain run");
assert.ok(index.runs.every((r) => r.swarm === layout.id));
const indexPage = get("/");
assert.equal(indexPage.status, 200);
assert.ok(indexPage.body.includes(`href="/swarms/${layout.id}"`), "the index links to the swarm");
assert.ok(indexPage.body.includes("<h2>swarms</h2>"));

// ---- run pages resolve swarm run ids ------------------------------------------
const overview = json(`/runs/${layout.runIds[1]}`);
assert.equal(overview.id, layout.runIds[1]);
assert.equal(overview.outcome, "completed");
assert.equal(overview.members.length, 1);
assert.equal(get(`/runs/${layout.runIds[1]}`).status, 200);
assert.ok(get(`/runs/${layout.runIds[1]}`).body.includes(`href="/swarms/${layout.id}"`), "a swarm run's nav links to its swarm");
assert.equal(get(`/runs/${layout.runIds[1]}/graph`).status, 200);
assert.equal(get(`/runs/${layout.runIds[1]}/collaboration`).status, 200);
assert.equal(get(`/runs/${layout.runIds[1]}/files/REPORT`).status, 200);
assert.equal(get(`/runs/${layout.id}-h3`).status, 404);

// ---- ledger pages read a horde's ledgers through ?run= ------------------------
assert.equal(json("/facts").all.length, 0, "the project ledger has no facts");
assert.equal(json(`/facts?run=${layout.runIds[1]}`).all.length, 1, "h2's ledger has the fact");
assert.equal(json(`/facts?run=${layout.runIds[0]}`).all.length, 0);
assert.equal(get(`/ideas?run=${layout.runIds[1]}`).status, 200);
assert.equal(get(`/claims?run=${layout.runIds[1]}`).status, 200);
assert.equal(get(`/resources?run=${layout.runIds[1]}`).status, 200);
assert.equal(get(`/board?run=${layout.runIds[1]}`).status, 200);
assert.equal(get("/facts?run=../etc").status, 400);

// ---- the swarm page and graph -----------------------------------------------
const swarm = json(`/swarms/${layout.id}`);
assert.equal(swarm.hordes, 2);
assert.deepEqual(swarm.partition, ["slice 1", "slice 2"]);
assert.equal(swarm.merge, "no deliverable");
assert.equal(swarm.active, false);
assert.equal(swarm.rows.length, 2);
assert.equal(swarm.rows[1].label, "h2");
assert.equal(swarm.rows[1].outcome, "completed");
assert.equal(swarm.rows[1].slice, "slice 2");
assert.equal(swarm.rows[1].count, 1);
assert.equal(swarm.elapsedMs, 90_000);
const swarmPage = get(`/swarms/${layout.id}`);
assert.equal(swarmPage.status, 200);
assert.ok(swarmPage.body.includes(`href="/runs/${layout.runIds[0]}"`), "rows link to the run pages");
assert.ok(swarmPage.body.includes(`href="/swarms/${layout.id}/files/REPORT"`));
assert.ok(swarmPage.body.includes("REPORT.md") && swarmPage.body.includes("DELIVERABLE.md: not yet"));
assert.equal(get(`/swarms/${layout.id}/files/REPORT`).status, 200);
assert.equal(get(`/swarms/${layout.id}/files/DELIVERABLE`).status, 404);
assert.equal(get(`/swarms/${layout.id}/files/passwd`).status, 400);
assert.equal(get("/swarms/nope").status, 400);
assert.equal(get("/swarms/20990101-000000").status, 404);

const graph = json(`/swarms/${layout.id}/graph`);
assert.deepEqual(graph.graph.lanes.map((lane) => lane.id), ["swarm", "h1", "h2"]);
assert.equal(graph.graph.lanes[1].href, `/runs/${layout.runIds[0]}`);
assert.equal(graph.graph.phases.length, 0, "phases are per horde, drawn as lane marks");
const kinds = graph.graph.nodes.map((node) => `${node.lane}:${node.label}`);
assert.ok(kinds.includes("h1:discovery start") && kinds.includes("h2:discovery end") && kinds.includes("h1:end"), kinds.join(", "));
assert.ok(kinds.includes("swarm:merge start") && kinds.includes("swarm:merge end (no deliverable)"), kinds.join(", "));
assert.equal(graph.graph.edges.filter((edge) => edge.to === "merge-start").length, 2, "every horde's end feeds the merge");
assert.equal(graph.graph.start, startedAt);
assert.ok(graph.graph.end >= startedAt + 90_000, "the graph runs to the latest of the merge end and the recorded events");
assert.equal(get(`/swarms/${layout.id}/graph`).status, 200);
assert.ok(get(`/swarms/${layout.id}/graph`).body.includes("<svg"));

// A live swarm reports its state from memory and its graph runs to now.
const liveRun = (i) => ({
  id: layout.runIds[i], hordeDir: layout.hordeDirs[i], runDir: layout.runDirs[i], prompt: "split task", count: 1, startedAt, stopped: false,
  members: [{ name: "member-1", status: "running", turns: 1, toolCalls: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, lastText: "", finalText: "", startedAt }],
  startFactId: 0, horde: i + 1, hordes: 2,
});
const liveSwarm = { id: layout.id, dir: layout.dir, hordes: 2, count: 1, prompt: "split task", startedAt, runs: [liveRun(0), liveRun(1)], partition: ["slice 1", "slice 2"] };
const liveSrc = { hordeDir, getActive: () => liveSwarm.runs, getFinalizing: () => [], getSwarm: () => liveSwarm, now: () => startedAt + 120_000 };
const liveVm = data.loadSwarm(liveSrc, layout.id);
assert.equal(liveVm.active, true);
assert.equal(liveVm.rows[0].active, true);
assert.equal(liveVm.elapsedMs, 120_000);
const livePage = dashboard.routeRequest(liveSrc, "GET", new URL(`http://127.0.0.1:7433/swarms/${layout.id}`), "127.0.0.1:7433");
assert.ok(livePage.body.includes("<b>ACTIVE</b>"));
assert.ok(livePage.body.includes("refresh"), "a live swarm page auto-refreshes");
assert.ok(data.loadSwarmGraph(liveSrc, layout.id, { width: 1200, from: 0, to: 0 }).graph.end >= startedAt + 120_000, "a live graph runs to now");

// ---- swarm-wide ledgers: every horde on one page ----------------------------
// The swarm page's nav points ledger links at the swarm aggregate, not the empty project root.
const swarmNav = get(`/swarms/${layout.id}`).body.match(/<nav>.*?<\/nav>/)[0];
for (const k of ["ideas", "board", "findings", "claims", "facts", "resources"]) {
  assert.ok(swarmNav.includes(`href="/swarms/${layout.id}/${k}"`), `swarm nav links ${k} to the aggregate: ${swarmNav}`);
}
// A horde run page keeps run-scoped ledger links, not the swarm aggregate.
const runNav = get(`/runs/${layout.runIds[1]}`).body.match(/<nav>.*?<\/nav>/)[0];
assert.ok(runNav.includes(`href="/findings?run=${layout.runIds[1]}"`), `a horde run page filters ledgers to that horde: ${runNav}`);

for (const k of ["ideas", "board", "findings", "claims", "facts", "resources"]) {
  assert.equal(get(`/swarms/${layout.id}/${k}`).status, 200, `/swarms/<id>/${k} serves`);
}
assert.equal(get(`/swarms/nope/findings`).status, 400);
assert.equal(get(`/swarms/20990101-000000/findings`).status, 404);

// The aggregate shows one section per horde, each linking to its run, with that horde's own ledger.
const factsAgg = json(`/swarms/${layout.id}/facts`);
assert.deepEqual(factsAgg.sections.map((s) => s.label), ["h1", "h2"]);
assert.deepEqual(factsAgg.sections.map((s) => s.runId), layout.runIds);
assert.equal(factsAgg.sections[0].vm.all.length, 0, "h1 has no facts");
assert.equal(factsAgg.sections[1].vm.all.length, 1, "h2's fact is read from h2's ledger");
assert.equal(factsAgg.sections[1].vm.all[0].text, "a fact only h2 knows");
const factsPage = get(`/swarms/${layout.id}/facts`);
assert.ok(factsPage.body.includes(`href="/runs/${layout.runIds[0]}"`) && factsPage.body.includes(`href="/runs/${layout.runIds[1]}"`), "each section links to its horde run");
assert.ok(factsPage.body.includes("a fact only h2 knows"), "the h2 fact shows on the swarm-wide facts page");
assert.ok(factsPage.body.includes("ids repeat per horde"), "the page says ids are per horde");

// A swarm with no hordes on disk still renders rather than 500ing.
fs.mkdirSync(path.join(hordeDir, "swarms", "20261024-070000"));
const emptySwarm = get("/swarms/20261024-070000/findings");
assert.equal(emptySwarm.status, 200);
assert.ok(emptySwarm.body.includes("no hordes"), emptySwarm.body.slice(0, 200));

console.log("PASS: horde-swarm-dashboard-test ledgers");

// ---- the graph builder on its own -------------------------------------------
const empty = graphMod.buildSwarmGraph({ swarmId: "x", startedAt: 1_000, hordes: [{ label: "h1", runId: "r-h1", events: [] }] });
assert.equal(empty.end, 2_000, "an empty graph still has a time axis");
assert.deepEqual(empty.lanes.map((l) => l.id), ["swarm", "h1"]);
assert.equal(empty.nodes.length, 0);

console.log("PASS: horde-swarm-dashboard-test");
