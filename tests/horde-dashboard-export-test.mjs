import assert from "node:assert/strict";
import * as http from "node:http";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createJiti, DEPS, PI } from "./harness.mjs";
import { buildHordeFixture, FIXTURE_OLDER_RUN, FIXTURE_RUN } from "./fixtures.mjs";

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
const exporter = await jiti.import("../src/dashboard-export.ts");

/** Reads a zip through its central directory: name -> inflated bytes, verifying every CRC. */
function readZip(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "end of central directory present");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, `central header ${i}`);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const csize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
    assert.equal(zip.readUInt32LE(offset), 0x04034b50, `local header of ${name}`);
    const localNameLen = zip.readUInt16LE(offset + 26);
    const localExtraLen = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(data.length, size, `size of ${name}`);
    assert.equal(zlib.crc32(data), crc, `crc of ${name}`);
    files.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(files.size, count, "every central entry is unique");
  return files;
}

// --- File naming -----------------------------------------------------------
assert.equal(exporter.exportFile(new URL("http://h/")), "index.html");
assert.equal(exporter.exportFile(new URL("http://h/runs/x")), "runs/x.html");
assert.equal(exporter.exportFile(new URL("http://h/board?order=newest&run=all")), "board~order=newest~run=all.html");
assert.equal(exporter.exportFile(new URL("http://h/runs/x/graph.mmd")), "runs/x/graph.mmd");
assert.equal(exporter.exportFile(new URL("http://h/runs/x/sessions/a%20b.jsonl?from=0")), "runs/x/sessions/a_b.jsonl~from=0.html");
// Values from ledgers cannot steer a zip entry out of its folder.
assert.equal(exporter.exportFile(new URL("http://h/ideas?owner=../../../etc/x")), "ideas~owner=.._.._.._etc_x.html");
assert.equal(exporter.exportFile(new URL("http://h/ideas?owner=..%5C..%5Cx")), "ideas~owner=.._.._x.html");
assert.equal(exporter.exportFile(new URL("http://h/runs/..%2F..%2Fetc/files/TASK")), "runs/.._.._etc/files/TASK.html");
for (const url of ["http://h/ideas?owner=../../../etc/x", "http://h/runs/..%2F..%2Fetc"]) {
  const file = exporter.exportFile(new URL(url));
  assert.ok(!path.posix.normalize(file).startsWith("..") && !file.includes("/../"), `${url} stays inside the folder`);
}

// --- The crawler follows links, rewrites them relative to each file, and keeps hashes -----
const fake = (url) => {
  switch (url.pathname + url.search) {
    case "/": return { body: '<a href="/runs/x?b=2&amp;a=1#top">x</a> <a href="#local">l</a> <a href="/runs/x/graph.mmd">m</a>' };
    case "/runs/x?a=1&b=2": return { body: '<a href="/">home</a><a href="/runs/x?b=2&amp;a=1">self</a>' };
    case "/runs/x/graph.mmd": return { body: "flowchart LR\n  click a \"/runs/x\"", text: true };
    default: throw new Error(`unexpected ${url}`);
  }
};
const crawled = [];
for await (const entry of exporter.crawlDashboard(fake)) crawled.push(entry);
assert.deepEqual(crawled.map((f) => f.path), ["index.html", "runs/x~a=1~b=2.html", "runs/x/graph.mmd"]);
assert.equal(crawled[0].data.toString(), '<a href="runs/x~a=1~b=2.html#top">x</a> <a href="#local">l</a> <a href="runs/x/graph.mmd">m</a>');
assert.equal(crawled[1].data.toString(), '<a href="../index.html">home</a><a href="x~a=1~b=2.html">self</a>');
assert.equal(crawled[2].data.toString(), 'flowchart LR\n  click a "/runs/x"', "text pages are not rewritten");

// --- The zip writer round-trips through the reader, stored and deflated alike ----
const tiny = await exporter.collect(exporter.zipArchive([
  { path: "a/b.html", data: Buffer.from("hello hello hello hello hello hello") },
  { path: "z", data: Buffer.from([1]) },
], new Date("2026-10-20T12:34:56Z")));
const tinyFiles = readZip(tiny);
assert.equal(tinyFiles.get("a/b.html").toString(), "hello hello hello hello hello hello");
assert.deepEqual([...tinyFiles.get("z")], [1]);

// --- The real dashboard exports as a self-contained site --------------------
const HORDE = buildHordeFixture();
const source = { hordeDir: HORDE, getActive: () => undefined };
const { filename, zip } = await dash.exportDashboardBuffer(source, new Date("2026-10-20T12:34:56Z"));
assert.equal(filename, "horde-dashboard-2026-10-20-12-34-56.zip");
const files = readZip(zip);
const FOLDER = "horde-dashboard-2026-10-20-12-34-56";
const html = (name) => {
  const data = files.get(`${FOLDER}/${name}`);
  assert.ok(data, `export has ${name}`);
  return data.toString("utf8");
};

const index = html("index.html");
assert.ok(index.includes(FIXTURE_RUN) && index.includes(FIXTURE_OLDER_RUN), "index lists both runs");
assert.ok(index.includes('href="findings~run=all.html"') || index.includes('href="findings.html"'), "nav links are relative");

let pages = 0;
for (const [name, data] of files) {
  if (!name.endsWith(".html")) continue;
  pages++;
  const text = data.toString("utf8");
  const rel = name.slice(FOLDER.length + 1);
  assert.ok(!text.includes('href="/'), `${rel} has an absolute link`);
  assert.ok(!text.includes("http-equiv"), `${rel} auto-refreshes`);
  assert.ok(!text.includes('id="export"') && !text.includes("export dashboard"), `${rel} shows the export control`);
  assert.ok(!text.includes("data-expand"), `${rel} keeps URL-backed disclosure`);
  assert.ok(!text.includes("[show body]") && !text.includes("[hide body]"), `${rel} keeps finding toggles`);
  assert.ok(!text.includes("auto-refresh"), `${rel} shows the refresh line`);
  for (const match of text.matchAll(/href="([^"#]*)(#[^"]*)?"/g)) {
    const target = match[1];
    if (target === "") continue;
    const resolved = path.posix.join(path.posix.dirname(name), target);
    assert.ok(files.has(resolved), `${rel} links to missing ${target}`);
  }
}
assert.ok(pages > 20, `exported ${pages} pages`);

const findings = html("findings~run=all~view=list.html");
assert.ok(findings.includes("fixture detail line shown only when expanded"), "finding bodies are inline");
const sessions = html(`runs/${FIXTURE_RUN}/sessions.html`);
const file = /href="sessions\/([^"~]+)~from=0~n=50\.html"/.exec(sessions)?.[1];
assert.ok(file, "sessions page links a transcript");
const transcript = html(`runs/${FIXTURE_RUN}/sessions/${file}~from=0~n=50.html`);
assert.ok(transcript.includes("<details><summary>"), "disclosure is native details");
assert.ok(!transcript.includes(">n=20<") && !transcript.includes(">n=100<"), "the export offers one page size");
const entry = html(`runs/${FIXTURE_RUN}/sessions/${file}/3.html`);
assert.ok(entry.includes("raw json"), "entry pages are exported");
assert.ok(entry.includes(`href="../${file}~from=0~n=50.html"`), "back link returns to the crawled page");
html(`runs/${FIXTURE_RUN}/sessions/${file}~from=150~n=50.html`);
assert.ok(html(`runs/${FIXTURE_RUN}/graph.html`).includes("no events recorded"), "the graph page is exported");
html(`runs/${FIXTURE_RUN}/members/member-1/log~tail=0.html`);
html(`runs/${FIXTURE_RUN}/files/TASK.html`);

// --- Over HTTP: the zip downloads, the modal gates it, and the api has no twin -----
const server = await dash.startDashboard({ port: 0, source });
const base = `http://127.0.0.1:${server.port}`;
const download = await fetch(`${base}/export.zip`);
assert.equal(download.status, 200);
assert.equal(download.headers.get("content-type"), "application/zip");
assert.equal(download.headers.get("transfer-encoding"), "chunked", "the zip is streamed");
assert.match(download.headers.get("content-disposition"), /^attachment; filename="horde-dashboard-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip"$/);
const body = Buffer.from(await download.arrayBuffer());
assert.deepEqual([...body.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
assert.ok(readZip(body).has(`${download.headers.get("content-disposition").match(/"(.*)\.zip"/)[1]}/index.html`));
const api = await fetch(`${base}/api/export.zip`);
assert.equal(api.status, 404);
assert.equal(JSON.parse(await api.text()).status, 404);

const live = await (await fetch(`${base}/board`)).text();
assert.ok(live.includes('<a class="export" href="/board?refresh=0#export" title="export dashboard" aria-label="export dashboard">'), "icon opens the modal on the paused page");
assert.ok(live.includes('<div id="export" class="modal">'), "modal present");
assert.ok(live.includes('<a class="btn" href="/export?back=%2Fboard">download zip</a>'), "download goes through the export page");
assert.ok(live.includes('<a class="btn" href="/board">cancel</a>'), "cancel returns to the live page");
assert.ok(live.includes("secrets or credentials"), "warning names the risk");
const paused = await (await fetch(`${base}/board?refresh=0`)).text();
assert.ok(paused.includes('href="/board?refresh=0#export"') && paused.includes('<a class="btn" href="/board?refresh=0">cancel</a>'), "paused page stays paused");
const historical = await (await fetch(`${base}/runs/${FIXTURE_RUN}`)).text();
assert.ok(historical.includes(`href="/runs/${FIXTURE_RUN}#export"`), "non-live pages link the modal directly");
const notFound = await (await fetch(`${base}/nope`)).text();
assert.ok(notFound.includes('href="/nope#export"'), "error pages carry the control too");
const start = await fetch(`${base}/export?back=%2Fboard`);
assert.equal(start.status, 200);
const startHtml = await start.text();
assert.ok(startHtml.includes('<meta http-equiv="refresh" content="0;url=/export.zip">'), "the export page starts the download");
assert.ok(startHtml.includes('<a href="/board">back to the dashboard</a>'), "back link honoured");
assert.ok(startHtml.includes('<a href="/export.zip">download it directly</a>'), "manual fallback");
assert.ok(!startHtml.includes("auto-refresh"), "no refresh line on the export page");
for (const bad of ["//evil.example", "http://evil.example", "/\\evil", "not a path"]) {
  const text = await (await fetch(`${base}/export?back=${encodeURIComponent(bad)}`)).text();
  assert.ok(text.includes('<a href="/">back to the dashboard</a>'), `back=${bad} falls back to /`);
}
assert.equal((await fetch(`${base}/api/export`)).status, 404);
const headZip = await fetch(`${base}/export.zip`, { method: "HEAD" });
assert.equal(headZip.status, 200);
assert.equal((await headZip.text()).length, 0);

// One export at a time: a second request while the first streams is refused, and the slot frees after.
const first = await fetch(`${base}/export.zip`);
const reader = first.body.getReader();
assert.ok(!(await reader.read()).done, "first chunk arrives");
const second = await fetch(`${base}/export.zip`);
assert.equal(second.status, 503);
assert.ok((await second.text()).includes("already in progress"));
for (;;) if ((await reader.read()).done) break;
const third = await fetch(`${base}/export.zip`);
assert.equal(third.status, 200);
readZip(Buffer.from(await third.arrayBuffer()));

// Other sites cannot start an export; the dashboard's own navigations can.
const withSite = (path, site) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: server.port, path, headers: { "Sec-Fetch-Site": site } }, (res) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode));
  });
  req.on("error", reject);
  req.end();
});
assert.equal(await withSite("/export.zip", "cross-site"), 403);
assert.equal(await withSite("/export", "cross-site"), 403);
assert.equal(await withSite("/export", "same-origin"), 200);
assert.equal(await withSite("/export.zip", "none"), 200);
assert.equal(await withSite("/board", "cross-site"), 200, "ordinary pages are unaffected");
await server.close();
console.log("PASS: horde-dashboard-export-test");
