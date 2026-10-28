// Dashboard edge cases: HTML escaping of user content, oversized sessions,
// traversal via percent-encoding, HEAD on the JSON API, paging caps.
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
const dash = await jiti.import("../src/dashboard.ts");
const ledger = {
  ...(await jiti.import("../src/ledger/board.ts")),
  ...(await jiti.import("../src/ledger/claims.ts")),
  ...(await jiti.import("../src/ledger/facts.ts")),
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/findings.ts")),
  ...(await jiti.import("../src/ledger/ideas.ts")),
};

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-dash-edge-"));
const hordeDir = ledger.initHordeDir(cwd);
const RUN = "20260101-000000";
const runId = RUN;
const runDir = path.join(hordeDir, "runs", runId);
fs.mkdirSync(path.join(runDir, "sessions", "member-1"), { recursive: true });
fs.writeFileSync(path.join(runDir, "SYSTEM.md"), "sys\n");
fs.writeFileSync(path.join(runDir, "TASK.md"), `# Horde run ${runId}\n\nStarted: 2026-01-01 00:00:00\nMembers: 1\nModel: x\nThinking: low\n\n## Prompt\n\npwn <script>alert(1)</script>\n`);
fs.writeFileSync(
  path.join(runDir, "member-1.log"),
  [
    "[horde] spawn: pi --mode json",
    "stderr <img src=x onerror=alert(1)>",
    "[horde] exit code 0 status done cause completed",
    "[horde] turns 2 toolCalls 1",
    "[horde] final: done <script>alert(1)</script>",
  ].join("\n") + "\n",
);
const sessionFile = path.join(runDir, "sessions", "member-1", "2026-01-01T00-00-00-000Z_abcdef.jsonl");
fs.writeFileSync(
  sessionFile,
  [
    JSON.stringify({ type: "session", id: "sess-<xss>", cwd: "/p" }),
    JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "<script>alert(document.cookie)</script>" } }),
    JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", model: "m", stopReason: "stop", usage: { input: 5, output: 2, cost: { total: 0.001 } }, content: [{ type: "text", text: "\"><img src=x onerror=alert(2)>" }] } }),
  ].join("\n") + "\n",
);
await ledger.appendRunHeading(hordeDir, runId, "pwn <script>");
await ledger.postBoard(hordeDir, "member-1", "board <script>alert(3)</script>");
await ledger.addIdea(hordeDir, "member-1", "idea <script>alert(4)</script>");
await ledger.addFinding(hordeDir, runId, "member-1", "finding <script>alert(5)</script>\nbody <img src=x>", { importance: "high" });
await ledger.assertClaim(hordeDir, "member-1", "claim <script>alert(6)</script>");
await ledger.addFact(hordeDir, "member-1", "fact <script>alert(7)</script>");

const source = { hordeDir, getActive: () => [] };
const server = await dash.startDashboard({ port: 0, source });
const base = `http://127.0.0.1:${server.port}`;
const get = async (p, init) => {
  const res = await fetch(`${base}${p}`, init);
  return { res, text: await res.text() };
};

const htmlPages = [
  "/",
  `/runs/${runId}`,
  `/runs/${runId}/members/member-1`,
  `/runs/${runId}/members/member-1/log?tail=0`,
  `/runs/${runId}/members/member-1/transcript?from=0&n=50`,
  `/runs/${runId}/members/member-1/transcript/1`,
  `/runs/${runId}/members/member-1/transcript/2`,
  `/runs/${runId}/files/TASK`,
  `/ideas`,
  `/board`,
  `/findings`,
  `/claims`,
  `/facts`,
  `/runs/${runId}/ideas`,
  `/runs/${runId}/board`,
  `/runs/${runId}/findings`,
  `/runs/${runId}/claims`,
  `/runs/${runId}/facts`,
];
for (const p of htmlPages) {
  const { res, text } = await get(p);
  assert.equal(res.status, 200, `${p}: ${text.slice(0, 200)}`);
  assert.ok(!/<script>alert/.test(text), `${p} leaked a raw <script> tag`);
  assert.ok(!/<img src=x/.test(text), `${p} leaked a raw <img>`);
  assert.ok(!/<[a-zA-Z][^>]*onerror=/.test(text), `${p} leaked a live event handler`);
  assert.ok(text.includes("&lt;script&gt;") || text.includes("&quot;&gt;&lt;img"), `${p} should show escaped content`);
}

// HEAD on the JSON API has no body.
const head = await get(`/api/runs/${runId}`, { method: "HEAD" });
assert.equal(head.res.status, 200);
assert.equal(head.text.length, 0);
assert.equal(head.res.headers.get("content-type"), "application/json; charset=utf-8");

// Percent-encoded traversal is rejected.
for (const p of [`/runs/${runId}/sessions/..%2F..%2FIDEAS.md`, `/runs/${runId}/sessions/%2e%2e%2f%2e%2e%2fTASK.md`, `/runs/${runId}/files/%2e%2e%2fIDEAS`]) {
  const { res } = await get(p);
  assert.equal(res.status, 400, `${p} should be rejected, got ${res.status}`);
}
// Invalid owner and run ids.
assert.equal((await get("/ideas?owner=root")).res.status, 400);
assert.equal((await get("/runs/nope/facts")).res.status, 400);
assert.equal((await get(`/runs/${runId}/members/member-1?tail=0`)).res.status, 400);
assert.equal((await get(`/runs/${runId}/members/member-1/log?tail=99999`)).res.status, 400);
// refresh=3 is the default and accepted.
assert.equal((await get(`/runs/${runId}?refresh=3`)).res.status, 200);

// Findings cluster view groups the one finding.
const clusters = JSON.parse((await get(`/api/runs/${runId}/findings?view=clusters`)).text);
assert.equal(clusters.view, "clusters");
assert.ok(clusters.clusters.length >= 1);

// Board order and the run scope agree with the parser.
const boardVm = JSON.parse((await get(`/api/runs/${runId}/board?order=oldest`)).text);
assert.equal(boardVm.order, "oldest");
assert.ok(boardVm.entries.length >= 1);
assert.ok(boardVm.entries.every((e) => e.runId === runId));

await server.close();

// Oversized session file: transcripts answer 413, but the run overview path
// computes per-member stats unguarded.
const bigRun = "20260102-000000";
const bigDir = path.join(hordeDir, "runs", bigRun);
fs.mkdirSync(path.join(bigDir, "sessions", "member-1"), { recursive: true });
fs.writeFileSync(path.join(bigDir, "TASK.md"), `# Horde run ${bigRun}\n\nStarted: 2026-01-02 00:00:00\nMembers: 1\n\n## Prompt\n\nbig\n`);
fs.writeFileSync(path.join(bigDir, "member-1.log"), "[horde] exit code 0 status done cause completed\n[horde] turns 1 toolCalls 0\n");
const bigSession = path.join(bigDir, "sessions", "member-1", "2026-01-02T00-00-00-000Z_beef.jsonl");
fs.writeFileSync(bigSession, "");
fs.truncateSync(bigSession, 65 * 1024 * 1024);

const server2 = await dash.startDashboard({ port: 0, source });
const base2 = `http://127.0.0.1:${server2.port}`;
const transcript = await fetch(`${base2}/runs/${bigRun}/members/member-1/transcript?from=0&n=5`);
console.log("oversized transcript status:", transcript.status);
const overview = await fetch(`${base2}/runs/${bigRun}`);
const overviewBody = await overview.text();
console.log("oversized overview status:", overview.status);
if (overview.status !== 200) {
  console.log("oversized overview body:", overviewBody.slice(0, 160));
}
await server2.close();

fs.rmSync(cwd, { recursive: true, force: true });
console.log("PASS: horde-dashboard-edge-test");
