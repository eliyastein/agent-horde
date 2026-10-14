import assert from "node:assert/strict";
import * as http from "node:http";
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
const dash = await jiti.import("../src/dashboard.ts");
const data = await jiti.import("../src/dashboard-data.ts");
import { buildHordeFixture } from "./fixtures.mjs";

const HORDE = buildHordeFixture();
const RUN = "20260913-010341";
const source = { hordeDir: HORDE, getActive: () => undefined };
const server = await dash.startDashboard({ port: 0, source });
assert.ok(server.port > 0);
assert.equal(server.url, `http://127.0.0.1:${server.port}/`);

const get = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, init);
  return { res, text: await res.text() };
};
const expectHtml = async (path, ...needles) => {
  const { res, text } = await get(path);
  assert.equal(res.status, 200, `${path}: ${text.slice(0, 200)}`);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(text.startsWith("<!doctype html>"), path);
  for (const needle of needles) assert.ok(text.includes(needle), `${path} lacks ${needle}`);
  const api = await get(`/api${path}`);
  assert.equal(api.res.status, 200, `/api${path}`);
  assert.equal(api.res.headers.get("content-type"), "application/json; charset=utf-8");
  JSON.parse(api.text);
  return text;
};

const sessions = data.listRunSessions(source, RUN);
const file = sessions.files[0].name;
await expectHtml("/", RUN, "20260913-010151", "finished", "evaluate the implementation");
const overview = await expectHtml(`/runs/${RUN}`, "member-1", "member-3", "SUMMARY.md", "REPORT.md: not yet", "unmapped session");
assert.ok(!overview.includes("http-equiv"), "historical run is not live");
await expectHtml(`/runs/${RUN}/members/member-1`, "member-1.log", "[horde] spawn", "none mapped");
await expectHtml(`/runs/${RUN}/members/member-1/log?tail=1`, "showing last 1 of 2");
await expectHtml(`/runs/${RUN}/members/member-1/log?tail=0`, "2 lines");
await expectHtml(`/runs/${RUN}/sessions`, file, "unmapped");
await expectHtml(`/runs/${RUN}/sessions/${file}?from=0&n=20`, "entries 0..20", "toolCall <b>read</b>", "evaluate the implementation");
await expectHtml(`/runs/${RUN}/sessions/${file}?from=last&n=5`, "entries 169..174 of 174");
await expectHtml(`/runs/${RUN}/sessions/${file}/3`, "entry #3", "raw json");
await expectHtml(`/runs/${RUN}/files/TASK`, "# Horde run");
await expectHtml(`/runs/${RUN}/files/SUMMARY`, "member-1");
await expectHtml("/ideas", "in progress", "done (");
await expectHtml("/ideas?owner=member-1", "owner:");
const board = await expectHtml("/board", "01:03:55", "member-2", "http-equiv");
assert.ok(board.includes('content="3"'));
await expectHtml(`/board?run=${RUN}&order=oldest`, "[newest first]");
const FINDING_BODY = "fixture detail line shown only when expanded";
const findingsClosed = await expectHtml(
  "/findings", "F1", '<a href="/findings?run=all&amp;view=list&amp;open=1">[show body]</a>',
);
assert.ok(!findingsClosed.includes(FINDING_BODY), "finding body is collapsed by default");
const findingsOpen = await expectHtml(
  "/findings?open=1", FINDING_BODY, '<a href="/findings?run=all&amp;view=list">[hide body]</a>', "http-equiv",
);
assert.ok(!findingsOpen.includes("[show body]"), "open finding has no show link");
const openPaused = await get("/findings?open=1&refresh=0");
assert.ok(openPaused.text.includes('href="/findings?open=1"'), "resume link keeps open state");
assert.ok(openPaused.text.includes(FINDING_BODY), "paused page keeps the body expanded");
await expectHtml(`/findings?run=${RUN}&view=clusters`, "cluster 1", "[show body]");
await expectHtml(`/findings?run=${RUN}&view=clusters&open=1`, "cluster 1", FINDING_BODY, "[hide body]");
const openApi = await get("/api/findings?open=1,1");
assert.deepEqual(JSON.parse(openApi.text).open, [1], "api exposes deduped open ids");
await expectHtml("/claims");
await expectHtml(`/facts?run=${RUN}`, "attribution is only available");
const paused = await get("/board?refresh=0");
assert.ok(!paused.text.includes("http-equiv"));
assert.ok(paused.text.includes("[resume]"));

const expectStatus = async (path, status, needle, init) => {
  const { res, text } = await get(path, init);
  assert.equal(res.status, status, `${path}: ${text.slice(0, 200)}`);
  if (needle) assert.ok(text.includes(needle), `${path} lacks ${needle}`);
  return text;
};
await expectStatus("/runs/..%2F..%2Fetc/files/TASK", 400, "invalid run id");
await expectStatus(`/runs/${RUN}/files/../../IDEAS`, 400, "invalid run id");
await expectStatus(`/runs/${RUN}/files/passwd`, 400, "unknown run file");
await expectStatus(`/runs/${RUN}/members/member-99`, 400, "invalid member");
await expectStatus(`/runs/${RUN}/members/member-9`, 404, "has no member-9");
await expectStatus(`/runs/${RUN}/files/REPORT`, 404, "has not been written yet");
await expectStatus(`/api/runs/${RUN}/files/REPORT`, 404, '"status":404');
await expectStatus("/runs/20991231-000000", 404, "no run");
await expectStatus(`/runs/${RUN}/sessions/${file}?n=abc`, 400, "invalid n");
await expectStatus(`/runs/${RUN}/sessions/${file}?n=0`, 400, "n must be");
await expectStatus("/board?order=sideways", 400, "invalid order");
await expectStatus("/board?refresh=9", 400, "invalid refresh");
await expectStatus("/findings?open=1,x", 400, "invalid open");
await expectStatus("/api/findings?open=-1", 400, "invalid open");
await expectStatus("/nope", 404, "no such page");
await expectStatus("/", 405, "not allowed", { method: "POST" });
const rawStatus = (host) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: server.port, path: "/", headers: { Host: host } }, (res) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode));
  });
  req.on("error", reject);
  req.end();
});
assert.equal(await rawStatus("evil.example"), 403);
assert.equal(await rawStatus("localhost:1"), 200);
assert.equal(await rawStatus(`127.0.0.1:${server.port}`), 200);
const head = await fetch(`http://127.0.0.1:${server.port}/`, { method: "HEAD" });
assert.equal(head.status, 200);
assert.equal((await head.text()).length, 0);
const xss = await get("/runs/%3Cscript%3E");
assert.equal(xss.res.status, 400);
assert.ok(!xss.text.includes("<script>"), "run id is escaped in the error page");
assert.ok(xss.text.includes("&lt;script&gt;"));

// Pure router: escaping, csp, and the api prefix without a trailing path.
const pure = dash.routeRequest(source, "GET", new URL("http://127.0.0.1/api"), "localhost:1");
assert.equal(pure.status, 200);
assert.equal(pure.headers["Content-Security-Policy"], "default-src 'none'; style-src 'unsafe-inline'");
assert.equal(dash.routeRequest(source, "GET", new URL("http://127.0.0.1/"), undefined).status, 403);
assert.equal(dash.resolveDashboardPort(9000), 9000);
assert.equal(dash.resolveDashboardPort(undefined), 7433);

// Live run: overview and member pages refresh, transcript only when tailing.
const live = {
  id: RUN, hordeDir: HORDE, runDir: `${HORDE}/runs/${RUN}`, prompt: "p", count: 1, startedAt: Date.now(), stopped: false,
  startFactId: 0, members: [{ name: "member-1", index: 1, status: "running", turns: 1, toolCalls: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, lastText: "hi", finalText: "", startedAt: Date.now() }],
};
const liveSource = { hordeDir: HORDE, getActive: () => live };
const liveHtml = (path) => dash.routeRequest(liveSource, "GET", new URL(`http://127.0.0.1${path}`), "127.0.0.1").body;
assert.ok(liveHtml(`/runs/${RUN}`).includes("http-equiv"));
assert.ok(liveHtml(`/runs/${RUN}`).includes("<b>ACTIVE</b>") === false);
assert.ok(liveHtml("/").includes("<b>ACTIVE</b>"));
assert.ok(liveHtml(`/runs/${RUN}/members/member-1`).includes("http-equiv"));
assert.ok(liveHtml(`/runs/${RUN}/members/member-1`).includes("last text"));
assert.ok(liveHtml(`/facts?run=${RUN}`).includes("this run ("));

// Lifecycle.
await assert.rejects(dash.startDashboard({ port: server.port, source }), /in use/);
await server.close();
await assert.rejects(fetch(`http://127.0.0.1:${server.port}/`));
console.log("PASS: horde-dashboard-http-test");
