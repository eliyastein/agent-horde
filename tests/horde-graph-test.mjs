// The run graph: events.jsonl projected into lanes, phases, nodes, and edges; rendered as an
// SVG swimlane with deep links and as a Mermaid export; served by the dashboard.
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
const files = await jiti.import("../src/ledger/files.ts");
const board = await jiti.import("../src/ledger/board.ts");
const events = await jiti.import("../src/ledger/events.ts");
const actions = await jiti.import("../src/tool/actions.ts");
const graphs = await jiti.import("../src/run-graph.ts");
const svg = await jiti.import("../src/run-graph-svg.ts");
const mermaid = await jiti.import("../src/run-graph-mermaid.ts");
const lifecycle = await jiti.import("../src/run/lifecycle.ts");
const finalize = await jiti.import("../src/run/finalize.ts");
const dashboard = await jiti.import("../src/dashboard.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-graph-"));
const hordeDir = files.initHordeDir(cwd);
const runId = "20260913-120000";
const runDir = path.join(hordeDir, "runs", runId);
fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(runDir, "TASK.md"), `# Horde run ${runId}\n\nStarted: 2026-09-13 12:00:00\nMembers: 2 (member-1 .. member-2)\n\n## Prompt\n\ngraph probe\n`);
fs.writeFileSync(path.join(runDir, "member-1.log"), "[horde] spawn: pi\n[horde] exit code 0 status done cause completed\n");
fs.writeFileSync(path.join(runDir, "member-2.log"), "[horde] spawn: pi\n");
await board.appendRunHeading(hordeDir, runId, "graph probe");

const fakeRun = { hordeDir, id: runId, runDir, members: [], startedAt: Date.now(), dashboardUrl: "http://127.0.0.1:7433/" };
const parent = (action, payload) => lifecycle.recordLifecycle(fakeRun, action, payload);
const act = (member, params) => actions.runHordeAction(hordeDir, member, params, runId, { attempt: `${member}-a1` });
const collab = async (member, params) => JSON.parse((await act(member, params)).text);

// ---- Parent lifecycle plus the ledger actions of a discovery pass -----------------------------
const runStart = await parent("run-start", { count: 2, verifier: "member-2", roles: ["", "verifier"] });
assert.equal(runStart.actor, "parent");
assert.equal(runStart.attempt, "lifecycle");
assert.equal(await lifecycle.recordLifecycle({ ...fakeRun, id: "bad id" }, "run-start", {}), undefined, "a failed audit write reports, never throws");
await parent("phase-start", { phase: "discovery" });
await parent("member-spawn", { member: "member-1", attempt: "member-1-a1" });
await parent("member-spawn", { member: "member-2", attempt: "member-2-a1", role: "verifier" });
const idea = await act("member-1", { action: "idea", text: "look at <script>alert(1)</script> auth" });
await act("member-1", { action: "claim", id: idea.id });
await act("member-1", { action: "post", text: "starting on auth" });
const findingText = 'Title "quoted" & <b>bold</b>\nbody line';
const concern = { concern: "auth-login", concernDef: "auth login root cause and entry point" };
const finding = await act("member-1", { action: "finding", idea: idea.id, ...concern, support: "sourced", importance: "high", text: findingText });
const duplicate = await act("member-1", { action: "finding", idea: idea.id, ...concern, support: "sourced", text: `${findingText} extra` });
assert.equal(duplicate.id, finding.id);
await assert.rejects(act("member-2", { action: "finding", idea: idea.id, ...concern, support: "sourced", text: "not my idea\nbody" }));
const fact = await act("member-2", { action: "fact", text: "host example.test resolves to 10.0.0.1" });
const resource = await act("member-2", { action: "resource", text: "shared lab environment", note: "ready at localhost:8080" });
await act("member-2", { action: "verify", id: finding.id, support: "tested", text: "reproduced locally" });

// ---- Collaboration: artifact, parent review assignment, delivery, transitions, evidence, review --
fs.writeFileSync(path.join(runDir, "artifacts/proof.mjs"), "console.log(1);\n");
const artifact = (await collab("member-1", { action: "artifact", artifactPath: "artifacts/proof.mjs", criteria: "prints 1" })).artifact;
const request = (await collab("parent", { action: "message", kind: "review-request", target: artifact.id, to: "member-2", text: "Independently check proof.mjs" })).message;
await events.recordEvent({ hordeDir, runId, actor: "member-2", attempt: "member-2-a1", requestId: `delivery:${request.id}:k1` }, "inbox-delivered", {
  payload: { transition: { id: request.id, state: "delivered", attempt: "k1" }, sessionEntry: "abcd1234" }, parents: [request.id],
});
await collab("member-2", { action: "ack", target: request.id, text: "on it" });
await collab("member-2", { action: "respond", target: request.id, revision: artifact.hash, text: "checking now" });
const evidence = (await collab("member-2", { action: "attach", target: artifact.id, text: "ran it, prints 1", relation: "supports" })).evidenceRecord;
const review = (await collab("member-2", { action: "review", target: artifact.id, revision: artifact.hash, verdict: "supports", support: "tested", checked: "ran proof.mjs", unchecked: "", refs: [evidence.id], text: "prints 1" })).review;

// ---- Wind-down: exits, repair, acceptance, end -----------------------------------------------
await parent("member-exit", { member: "member-1", attempt: "member-1-a1", status: "done", endCause: "completed", turns: 7, tokens: 1200 });
await parent("phase-end", { phase: "discovery" });
await events.recordEvent({ hordeDir, runId, actor: "member-2", attempt: "member-2-r1" }, "repair-start", { payload: { messages: [request.id] } });
await events.recordEvent({ hordeDir, runId, actor: "member-2", attempt: "member-2-r1" }, "repair-end", { payload: { cause: "completed", messages: [request.id] } });
await parent("acceptance", { status: "incomplete", hash: "abc123", issues: 1 });
await parent("run-end", { outcome: "completed-incomplete" });

// ---- Model ---------------------------------------------------------------------------------------
const all = events.readEvents(hordeDir, runId);
const graph = graphs.buildRunGraph({ runId, events: all, members: [{ name: "member-1", status: "done" }, { name: "member-2", status: "running" }] });
const node = (id) => graph.nodes.find((n) => n.id === id);
const edge = (from, to, label) => graph.edges.find((e) => e.from === from && e.to === to && (label === undefined || e.label === label));
assert.deepEqual(graph.lanes.map((lane) => lane.id), ["parent", "member-1", "member-2"]);
assert.equal(graph.lanes[2].label, "member-2 (verifier)");
assert.equal(graph.lanes[1].href, `/runs/${runId}/members/member-1`);
assert.equal(graph.lanes[1].status, "done");
assert.equal(graph.start, Date.parse(runStart.at));
assert.equal(graph.end, Date.parse(all.at(-1).at));
assert.deepEqual(graph.phases.map((phase) => phase.id), ["discovery"], "recorded phases win over the repair fallback");
assert.ok(graph.phases[0].to < graph.end);

const ideaNode = node(`I${idea.id}`);
assert.equal(ideaNode.kind, "idea");
assert.equal(ideaNode.lane, "member-1");
assert.equal(ideaNode.href, `/ideas#idea-${idea.id}`);
assert.ok(ideaNode.title.includes("<script>"), "the model keeps raw text; renderers escape");
const findingNode = node(`F${finding.id}`);
assert.equal(findingNode.href, `/findings?run=${runId}#F${finding.id}`);
assert.ok(edge(`F${finding.id}`, `I${idea.id}`, "under"));
const claimMarker = graph.nodes.find((n) => n.action === "claim");
assert.ok(claimMarker.marker);
assert.match(claimMarker.href, new RegExp(`^/runs/${runId}/collaboration\\?expanded=[a-f0-9]{20}#E${claimMarker.id.slice(1)}$`));
assert.ok(edge(claimMarker.id, `I${idea.id}`, "claims"));
const dupMarker = graph.nodes.find((n) => n.action === "finding" && n.marker && n.outcome === "applied");
assert.ok(edge(dupMarker.id, `F${finding.id}`, "duplicate"), "a repeated finding points at the one it duplicated");
const rejected = graph.nodes.find((n) => n.outcome === "rejected");
assert.equal(rejected.action, "finding");
assert.equal(rejected.lane, "member-2");
assert.equal(edge(rejected.id, `I${idea.id}`).tone, "negative");
const verifyMarker = graph.nodes.find((n) => n.action === "verify");
assert.equal(edge(verifyMarker.id, `F${finding.id}`, "verifies").tone, "verification");
assert.equal(node(`T${fact.id}`).href, `/facts?run=${runId}#T${fact.id}`);
assert.equal(node(`R${resource.id}`).href, `/resources#R${resource.id}`);
assert.equal(node(artifact.id).kind, "artifact");
assert.equal(node(artifact.id).href, `/runs/${runId}/collaboration#${artifact.id}`);
assert.equal(node(request.id).lane, "parent");
assert.ok(edge(request.id, artifact.id, "review-request"));
const delivered = graph.nodes.find((n) => n.action === "inbox-delivered");
assert.equal(delivered.lane, "member-2");
assert.ok(edge(request.id, delivered.id, "delivered"));
assert.ok(edge(graph.nodes.find((n) => n.action === "ack").id, request.id, "acknowledges"));
assert.ok(edge(graph.nodes.find((n) => n.action === "respond").id, request.id, "responds"));
assert.equal(node(evidence.id).kind, "evidence");
assert.ok(edge(evidence.id, artifact.id, "supports"));
assert.equal(node(review.id).kind, "review");
assert.ok(edge(review.id, artifact.id, "supports"));
assert.ok(edge(evidence.id, review.id, "cited"));
assert.equal(graph.nodes.find((n) => n.action === "member-spawn").lane, "member-1");
assert.equal(graph.nodes.find((n) => n.action === "member-spawn").kind, "lifecycle");
assert.equal(graph.nodes.find((n) => n.action === "acceptance").lane, "parent");
assert.ok(graph.nodes.find((n) => n.action === "run-end"));
assert.ok(!graph.nodes.some((n) => n.action === "phase-start"), "phase boundaries are bands, not nodes");

// A historical run with no lifecycle events falls back to discovery plus the repair span.
const historical = graphs.buildRunGraph({ runId, events: all.filter((e) => e.attempt !== "lifecycle"), startedAt: graph.start - 5000 });
assert.deepEqual(historical.phases.map((phase) => phase.id), ["discovery", "repair"]);
assert.equal(historical.start, graph.start - 5000);
assert.equal(historical.phases[1].from, graph.nodes.find((n) => n.action === "repair-start").at);
// A target created before the run gets a dashed placeholder at the start, in the parent lane.
const prior = graphs.buildRunGraph({ runId, events: all.filter((e) => e.action !== "idea" || e.outcome !== "applied") });
assert.equal(prior.nodes.find((n) => n.id === `I${idea.id}`).placeholder, true);
assert.equal(prior.nodes.find((n) => n.id === `I${idea.id}`).lane, "parent");
assert.deepEqual(graphs.buildRunGraph({ runId, events: [] }).lanes.map((lane) => lane.id), ["parent"]);

// ---- SVG -----------------------------------------------------------------------------------------
const picture = svg.renderRunGraphSvg(graph, { width: 1200, from: 0, to: 0 });
assert.ok(picture.startsWith("<svg "));
assert.ok(picture.includes(`<a href="/ideas#idea-${idea.id}">`));
assert.ok(picture.includes(`<a href="/findings?run=${runId}#F${finding.id}">`));
assert.ok(picture.includes(`<a href="/runs/${runId}/members/member-1">`));
assert.ok(picture.includes("&lt;script&gt;") && !picture.includes("<script>"), "titles are escaped");
assert.ok(picture.includes("&quot;quoted&quot;"));
assert.ok(picture.includes("member-2 (verifier)"));
assert.ok(picture.includes("discovery +00:00 to +"));
assert.ok(picture.includes('class="n n-finding"'));
assert.ok(picture.includes('class="m m-rejected"'));
assert.ok(picture.includes('class="e e-verification"'));
assert.ok(picture.includes("marker-end=\"url(#arrow-structure)\""));
const zoomed = svg.renderRunGraphSvg(graph, { width: 800, from: 600_000, to: 0 });
assert.ok(zoomed.startsWith("<svg ") && !zoomed.includes(`#F${finding.id}`), "a window after the last event shows lanes only");
assert.ok(svg.renderRunGraphSvg(prior, { width: 600, from: 0, to: 0 }).includes('n-prior'));
assert.ok(svg.graphLegendHtml().includes("finding"));

// ---- Mermaid -------------------------------------------------------------------------------------
const text = mermaid.renderRunGraphMermaid(graph, "http://127.0.0.1:7433/");
assert.ok(text.startsWith("%% Horde run "));
assert.ok(text.includes("\nflowchart LR\n"));
assert.ok(text.includes(`  click F${finding.id} "http://127.0.0.1:7433/findings?run=${runId}#F${finding.id}"`));
assert.ok(text.includes(`  click member_1 "http://127.0.0.1:7433/runs/${runId}/members/member-1"`));
assert.ok(text.includes(`  member_1 -.->|claims| I${idea.id}`));
assert.ok(text.includes(`  F${finding.id} -->|under| I${idea.id}`));
assert.ok(text.includes(`  ${request.id} -.->|delivered| member_2`));
assert.ok(text.includes('subgraph phase_discovery["discovery +00:00 to +'));
assert.ok(text.includes("#quot;quoted#quot;") && text.includes("#lt;script#gt;") && !text.includes("<script>"));
assert.ok(!/^\s*member_1 -.->\|post\|/m.test(text), "edge-less markers are dropped");
const markdown = mermaid.runGraphMarkdown(graph, "http://127.0.0.1:7433");
assert.ok(markdown.startsWith(`# Run graph ${runId}`) && markdown.includes("```mermaid\n%% Horde run"));
finalize.writeRunGraph(fakeRun);
assert.ok(fs.readFileSync(path.join(runDir, "GRAPH.md"), "utf8").includes(`click F${finding.id} "http://127.0.0.1:7433/findings`));

// ---- Dashboard -----------------------------------------------------------------------------------
const src = { hordeDir, getActive: () => undefined };
const get = (target) => dashboard.routeRequest(src, "GET", new URL(`http://127.0.0.1:7433${target}`), "127.0.0.1:7433");
const page = get(`/runs/${runId}/graph?w=800`);
assert.equal(page.status, 200, page.body.slice(0, 200));
assert.equal(page.contentType, "text/html; charset=utf-8");
assert.ok(page.body.includes("<svg ") && page.body.includes("mermaid export") && page.body.includes(`href="/runs/${runId}/graph"`));
assert.ok(page.body.includes("width: 800 "), "the current width is plain text, the others links");
assert.ok(!page.body.includes("http-equiv"), "a finished run does not auto-refresh");
const windowed = get(`/runs/${runId}/graph?from=1&to=2`);
assert.ok(windowed.body.includes("window: +00:01 to +00:02"));
const exported = get(`/runs/${runId}/graph.mmd`);
assert.equal(exported.status, 200);
assert.equal(exported.contentType, "text/plain; charset=utf-8");
assert.ok(exported.body.startsWith("%% Horde run ") && exported.body.includes(`"http://127.0.0.1:7433/findings?run=${runId}#F${finding.id}"`));
const api = JSON.parse(get(`/api/runs/${runId}/graph`).body);
assert.equal(api.graph.nodes.length, graph.nodes.length);
assert.equal(get(`/runs/${runId}/graph?w=10`).status, 400);
assert.equal(get(`/runs/${runId}/graph?from=abc`).status, 400);
assert.equal(get(`/runs/20260913-130000/graph`).status, 404);
const collaboration = get(`/runs/${runId}/collaboration`).body;
assert.ok(!collaboration.includes('aria-expanded="true"'), "audit entries start collapsed");
const opened = get(claimMarker.href.replace(/#.*$/, "")).body;
assert.ok(opened.includes(`<div id="${claimMarker.id}"><section id="detail-`) && opened.includes('aria-expanded="true"'), "an event link opens its entry");
assert.ok(opened.includes("&quot;action&quot;: &quot;claim&quot;"), "the opened entry shows the event json");
assert.equal((opened.match(/aria-expanded="true"/g) ?? []).length, 1, "only the linked entry opens");
for (const id of [artifact.id, request.id, review.id]) assert.ok(collaboration.includes(`id="${id}"`), `collaboration anchors ${id}`);
assert.ok(get("/facts").body.includes(`id="T${fact.id}"`));
assert.ok(get("/resources").body.includes(`id="R${resource.id}"`));
// A run that predates events.jsonl renders an empty graph page rather than an error.
const olderRun = "20260913-110000";
fs.mkdirSync(path.join(hordeDir, "runs", olderRun), { recursive: true });
fs.writeFileSync(path.join(hordeDir, "runs", olderRun, "TASK.md"), `# Horde run ${olderRun}\n\n## Prompt\n\nold\n`);
const older = get(`/runs/${olderRun}/graph`);
assert.equal(older.status, 200);
assert.ok(older.body.includes("no events recorded"));
assert.equal(get(`/runs/${olderRun}/graph.mmd`).status, 200);
// The collaboration and graph links are in the nav everywhere: the page's run, the ?run= filter, else the newest run.
const navOf = (body) => /<nav>(.*?)<\/nav>/.exec(body)[1];
for (const target of ["/", "/ideas", "/findings", "/claims", "/resources", `/runs/${runId}/members/member-1`]) {
  const nav = navOf(get(target).body);
  assert.ok(nav.includes(`href="/runs/${runId}/graph"`) && nav.includes(`href="/runs/${runId}/collaboration"`), `${target} links the newest run`);
}
assert.ok(navOf(get(`/findings?run=${olderRun}`).body).includes(`href="/runs/${olderRun}/graph"`), "the ?run= filter picks the nav run");
assert.ok(navOf(get(`/runs/${olderRun}/graph`).body).includes(`href="/runs/${olderRun}/collaboration"`), "a run page links its own run");
assert.ok(navOf(get("/findings?run=all").body).includes(`href="/runs/${runId}/graph"`), "run=all falls back to the newest run");
assert.ok(!navOf(dashboard.routeRequest({ hordeDir: files.initHordeDir(fs.mkdtempSync(path.resolve(".tmp/horde-graph-empty-"))), getActive: () => undefined }, "GET", new URL("http://127.0.0.1:7433/ideas"), "127.0.0.1:7433").body).includes("/graph"), "no runs, no run links");

console.log("horde-graph-test ok");
