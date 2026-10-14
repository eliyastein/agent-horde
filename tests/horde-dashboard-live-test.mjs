// Live end-to-end dashboard check: boot the extension with a fake `pi --mode json`
// child, start a run with --dashboard, and read the served pages while the run is
// active, while a clean stop is pending, and after it finalizes (server stays up).
// This file doubles as the fake long-running child when argv contains --mode.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv.includes("--mode")) {
  // Fake member: one assistant turn (so the canary passes), then idle forever.
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  process.stdout.write(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "live member working" }],
        usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0007 } },
        stopReason: "stop",
      },
    }) + "\n",
  );
  setInterval(() => {}, 1000);
} else {
  delete process.env.PI_HORDE_MEMBER;
  delete process.env.PI_HORDE_DIR;
  delete process.env.PI_HORDE_NAME;
  delete process.env.PI_HORDE_RUN;
  process.env.PI_HORDE_POSTMORTEM = "off";
  process.env.PI_HORDE_DELIVERABLE = "off";

  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": PI,
      "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
      "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
      typebox: `${DEPS}/typebox/build/index.mjs`,
    },
  });
  const mod = await jiti.import("../src/index.ts");
  const agentHordeExtension = mod.default ?? mod;

  const freePort = () =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
    });

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-live-dash-"));
  const hordeDir = path.join(cwd, ".horde");
  const commands = new Map();
  const notifications = [];
  const sent = [];
  const pi = {
    registerTool: () => {},
    registerCommand: (name, def) => commands.set(name, def),
    registerMessageRenderer: () => {},
    on: () => {},
    sendMessage: (msg, opts) => sent.push({ msg, opts }),
  };
  agentHordeExtension(pi);
  const ui = { notify: (text, level) => notifications.push(`${level}: ${text}`), setWidget: () => {}, setStatus: () => {} };
  const ctx = { cwd, hasUI: false, ui, isProjectTrusted: () => true };
  const command = commands.get("agent-horde");
  assert.ok(command, "agent-horde command registered");

  const runDirs = () =>
    fs.readdirSync(path.join(hordeDir, "runs")).filter((d) => fs.statSync(path.join(hordeDir, "runs", d)).isDirectory()).sort();
  const latestRun = () => runDirs()[runDirs().length - 1];
  const get = async (port, p, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
    return { res, text: await res.text() };
  };
  const waitFor = async (fn, label, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await wait(50);
    }
  };

  // Busy port: the run is refused before any run dir is created.
  const busyPort = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(busyPort, "127.0.0.1", resolve);
  });
  await command.handler(`--dashboard=${busyPort} 1 refused probe`, ctx);
  await wait(250);
  assert.equal(runDirs().length, 0, "no run dir when the port is busy");
  assert.ok(
    notifications.some((n) => /is in use|could not listen/.test(n)),
    `busy port error notified: ${notifications.slice(-3).join(" | ")}`,
  );
  await new Promise((resolve) => blocker.close(resolve));

  const port = await freePort();
  await command.handler(`--dashboard=${port} 1 live dashboard probe`, ctx);
  await wait(400);
  const runId = latestRun();
  assert.match(runId, /^\d{8}-\d{6}$/);
  const runDir = path.join(hordeDir, "runs", runId);

  // Live run index and overview: ACTIVE, auto-refresh, canary ok, live member.
  await waitFor(async () => (await get(port, "/")).res.status === 200, "dashboard to answer");
  let page = await get(port, "/");
  assert.equal(page.res.status, 200);
  assert.ok(page.text.includes("<b>ACTIVE</b>"), "run index marks the live run");
  assert.ok(page.text.includes(runId));

  page = await get(port, `/runs/${runId}`);
  assert.equal(page.res.status, 200);
  assert.ok(page.text.includes('http-equiv="refresh"'), "live overview auto-refreshes");
  assert.ok(/canary<\/th><td>ok/.test(page.text), "overview shows canary ok");
  assert.ok(page.text.includes("member-1"));
  assert.ok(/running/.test(page.text), "member row is running");

  // JSON twin of the live overview.
  const api = await get(port, `/api/runs/${runId}`);
  assert.equal(api.res.status, 200);
  assert.equal(api.res.headers.get("content-type"), "application/json; charset=utf-8");
  const vm = JSON.parse(api.text);
  assert.equal(vm.id, runId);
  assert.equal(vm.active, true);
  assert.equal(vm.outcome, "running");
  assert.equal(vm.canary, "ok");
  assert.equal(vm.members.length, 1);
  assert.equal(vm.members[0].name, "member-1");
  assert.equal(vm.members[0].live, true);
  assert.equal(vm.members[0].status, "running");
  assert.equal(vm.members[0].turns, 1);
  assert.ok(vm.members[0].usage.input >= 12, "live usage flows to the dashboard");

  // Member page is live too.
  page = await get(port, `/runs/${runId}/members/member-1`);
  assert.equal(page.res.status, 200);
  assert.ok(page.text.includes('http-equiv="refresh"'), "live member page auto-refreshes");
  assert.ok(page.text.includes("member-1.log"));

  // Board/ideas/findings are readable and live.
  for (const p of ["/ideas", "/board", "/findings", "/claims"]) {
    const r = await get(port, p);
    assert.equal(r.res.status, 200, p);
    assert.ok(r.text.startsWith("<!doctype html>"), p);
  }
  // Facts split for the active run.
  page = await get(port, `/facts?run=${runId}`);
  assert.equal(page.res.status, 200);
  assert.ok(page.text.includes("this run ("), "active run splits facts");

  // refresh=0 pauses auto-refresh.
  page = await get(port, `/runs/${runId}?refresh=0`);
  assert.ok(!page.text.includes("http-equiv"), "refresh=0 disables meta refresh");
  assert.ok(page.text.includes("[resume]"));

  // Clean stop: overview flips to stopping with a countdown.
  await command.handler("stop-clean member-1 --grace 5", ctx);
  page = await get(port, `/runs/${runId}`);
  assert.ok(page.text.includes("clean stop"), "clean stop countdown shown");
  assert.ok(/hard stop in \d+s/.test(page.text), "countdown is present");
  const stopping = JSON.parse((await get(port, `/api/runs/${runId}`)).text);
  assert.equal(stopping.outcome, "stopping");
  assert.ok(stopping.cleanStop && stopping.cleanStop.secondsLeft > 0);

  // Hard stop to finish fast; the dashboard server must survive finalize.
  await command.handler("stop-hard", ctx);
  await waitFor(() => fs.existsSync(path.join(runDir, "REPORT.md")), "REPORT.md");
  await waitFor(async () => (await get(port, `/api/runs/${runId}`)).res.status === 200, "server after finalize");
  const finished = JSON.parse((await get(port, `/api/runs/${runId}`)).text);
  assert.equal(finished.active, false, "run is no longer active after finalize");
  assert.equal(finished.outcome, "stopped-clean");
  assert.ok(finished.files.SUMMARY && finished.files.REPORT, "SUMMARY and REPORT exist");
  page = await get(port, `/runs/${runId}/files/REPORT`);
  assert.equal(page.res.status, 200);
  assert.ok(page.text.includes("outcome: stopped-clean"));

  // Run 2 with the flag reuses the same server (same port, still up).
  await command.handler(`--dashboard 2 reuse probe`, ctx);
  await wait(400);
  const run2 = latestRun();
  assert.notEqual(run2, runId);
  const reuse = await get(port, "/");
  assert.equal(reuse.res.status, 200, "server reused for the second run");
  assert.ok(reuse.text.includes("<b>ACTIVE</b>"));
  await command.handler("stop-hard", ctx);
  await waitFor(() => fs.existsSync(path.join(hordeDir, "runs", run2, "REPORT.md")), "run2 REPORT");

  // A run started without the flag closes the server.
  await command.handler("1 no dashboard probe", ctx);
  await waitFor(() => notifications.some((n) => /dashboard closed/.test(n)), "dashboard close notice");
  await wait(300);
  let closed = false;
  try {
    await fetch(`http://127.0.0.1:${port}/`);
  } catch {
    closed = true;
  }
  assert.ok(closed, "dashboard is closed after a run without --dashboard");
  await command.handler("stop-hard", ctx);
  await wait(400);

  await waitFor(() => sent.length >= 3, "reports");
  console.log("PASS: horde-dashboard-live-test");
  process.exit(0);
}
