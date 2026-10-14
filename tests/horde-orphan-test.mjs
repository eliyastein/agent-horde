// Regression: horde children must not outlive the parent pi process.
// Child roles (selected by argv/env) let this one file play the fake member.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const role = process.env.ORPHAN_ROLE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

if (role === "watched-child") {
  // A child that runs the real watchdog against a fake parent pid.
  const { startParentWatchdog } = await jiti.import("../src/watchdog.ts");
  const ignoreTerm = process.env.ORPHAN_IGNORE_TERM === "1";
  process.on("SIGTERM", () => {
    fs.writeFileSync(process.env.ORPHAN_MARK, "SIGTERM");
    if (!ignoreTerm) process.exit(143);
  });
  startParentWatchdog(Number(process.env.PI_HORDE_PARENT_PID), { pollMs: 200, graceMs: 500 });
  setInterval(() => {}, 1000);
} else if (process.argv.includes("--mode")) {
  // Fake `pi --mode json` member: emits one event, records SIGTERM, exits on it.
  process.on("SIGTERM", () => {
    fs.writeFileSync(process.env.ORPHAN_MARK, `SIGTERM ${process.env.PI_HORDE_PARENT_PID}`);
    process.exit(143);
  });
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  setInterval(() => {}, 1000);
} else if (role === "helper") {
  // Fake one-shot helper for execPi: prints its env and optionally lingers.
  process.stdout.write(`parent=${process.env.PI_HORDE_PARENT_PID}`);
  if (process.env.ORPHAN_LINGER === "1") setInterval(() => {}, 1000);
} else {
  const member = await jiti.import("../src/member.ts");
  const { isProcessAlive } = await jiti.import("../src/watchdog.ts");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "horde-orphan-"));
  const self = new URL(import.meta.url).pathname;

  // 1. isProcessAlive: our own pid is alive, a dead child's pid is not.
  assert.equal(isProcessAlive(process.pid), true);
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => dead.once("close", r));
  assert.equal(isProcessAlive(dead.pid), false, "exited pid must read as dead");

  // 2. Watchdog: SIGKILL the fake parent, the watched child terminates itself.
  for (const ignoreTerm of ["0", "1"]) {
    const fakeParent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const mark = path.join(tmp, `mark-${ignoreTerm}`);
    const child = spawn(process.execPath, [self], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, ORPHAN_ROLE: "watched-child", ORPHAN_MARK: mark, ORPHAN_IGNORE_TERM: ignoreTerm, PI_HORDE_PARENT_PID: String(fakeParent.pid) },
    });
    const exited = new Promise((r) => child.once("close", (code, signal) => r({ code, signal })));
    await sleep(600);
    assert.equal(alive(child.pid), true, "child runs while the fake parent lives");
    fakeParent.kill("SIGKILL");
    const result = await Promise.race([exited, sleep(4000).then(() => "still running")]);
    assert.notEqual(result, "still running", `watched child (ignoreTerm=${ignoreTerm}) must exit after parent death`);
    assert.equal(result.code, 143, `exit code 143 (ignoreTerm=${ignoreTerm}), got ${JSON.stringify(result)}`);
    assert.equal(fs.readFileSync(mark, "utf-8"), "SIGTERM", "child saw its own SIGTERM first");
  }

  // 3. execPi passes the parent pid through and kills a lingering helper on timeout.
  const helperEnv = { ...member.childEnv(), ORPHAN_ROLE: "helper" };
  const quick = await member.execPi({ command: process.execPath, args: [self] }, {
    cwd: tmp, env: helperEnv, timeoutMs: 10_000, signal: new AbortController().signal,
  });
  assert.equal(quick.code, 0);
  assert.equal(quick.timedOut, false);
  assert.equal(quick.stdout, `parent=${process.pid}`);
  const started = Date.now();
  const lingering = await member.execPi({ command: process.execPath, args: [self] }, {
    cwd: tmp, env: { ...helperEnv, ORPHAN_LINGER: "1" }, timeoutMs: 300, signal: new AbortController().signal,
  });
  assert.equal(lingering.timedOut, true);
  assert.equal(lingering.code, null, "killed by signal");
  assert.ok(Date.now() - started < 3000, "SIGTERM ends the helper without waiting for SIGKILL");
  const aborter = new AbortController();
  const abortedRun = member.execPi({ command: process.execPath, args: [self] }, {
    cwd: tmp, env: { ...helperEnv, ORPHAN_LINGER: "1" }, timeoutMs: 10_000, signal: aborter.signal,
  });
  await sleep(200);
  aborter.abort();
  assert.equal((await abortedRun).code, null, "abort kills the helper");

  // 4. terminateAllChildren signals a live member spawned through spawnMember.
  const runDir = path.join(tmp, "runs", "R1");
  fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "SYSTEM.md"), "protocol\n");
  const mark = path.join(tmp, "member-mark");
  process.env.ORPHAN_MARK = mark;
  const m = member.newMemberState(1);
  let proc;
  const done = member.spawnMember({
    member: m,
    run: { id: "R1", hordeDir: path.join(tmp, ".horde"), runDir, prompt: "x", count: 1 },
    cwd: tmp, approve: false, signal: new AbortController().signal,
    onChange: () => {}, onSpawn: (p) => { proc = p; },
  });
  await sleep(500);
  assert.equal(m.status, "running");
  assert.equal(member.liveChildCount(), 1);
  assert.equal(member.terminateAllChildren(), 1, "one live child signalled");
  await Promise.race([done, sleep(3000).then(() => assert.fail("member did not exit after SIGTERM"))]);
  assert.equal(fs.readFileSync(mark, "utf-8"), `SIGTERM ${process.pid}`, "member got SIGTERM and knew its parent pid");
  assert.equal(member.liveChildCount(), 0);
  assert.equal(member.terminateAllChildren(), 0, "nothing left to signal");
  assert.equal(alive(proc.pid), false);

  // 5. Parent-role extension hooks process exit and unhooks on session_shutdown.
  delete process.env.PI_HORDE_MEMBER;
  const { default: extension } = await jiti.import("../src/index.ts");
  const pi = { events: {}, registerCommand() {}, registerTool() {}, registerMessageRenderer() {}, on(e, fn) { this.events[e] = fn; }, sendMessage() {} };
  const before = process.listeners("exit").length;
  extension(pi);
  assert.equal(process.listeners("exit").length, before + 1, "exit hook registered");
  pi.events.session_shutdown({}, {});
  assert.equal(process.listeners("exit").length, before, "exit hook removed on shutdown");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("PASS: horde-orphan-test");
  process.exit(0);
}
