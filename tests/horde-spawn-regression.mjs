// spawnMember end-to-end + SIGTERM/SIGKILL escalation.
// This same file acts as the fake child pi when it sees "--mode json" in argv.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const PID_FILE = process.env.HORDE_TEST_PID_FILE;
const TERM_FILE = process.env.HORDE_TEST_TERM_FILE;

// ---------- child mode: fake pi --mode json ----------
if (process.argv.includes("--mode")) {
  fs.writeFileSync(PID_FILE, String(process.pid));
  const write = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  process.on("SIGTERM", () => {
    fs.writeFileSync(TERM_FILE, "SIGTERM");
    // Deliberately ignore SIGTERM and keep running, like a wedged child.
  });
  write({ type: "agent_start" });
  write({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      stopReason: "stop",
    },
  });
  setInterval(() => {}, 1000);
} else {
  // ---------- parent mode ----------
    const jiti = createJiti(import.meta.url, {
    fsCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": PI,
      "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
      "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
      typebox: `${DEPS}/typebox/build/index.mjs`,
    },
  });
  const member = await jiti.import("../src/member.ts");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "m1-spawn-"));
  const runDir = path.join(cwd, "runs", "R1");
  fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "SYSTEM.md"), "protocol\n");

  process.env.HORDE_TEST_PID_FILE = path.join(cwd, "pid");
  process.env.HORDE_TEST_TERM_FILE = path.join(cwd, "term");
  const run = { id: "R1", hordeDir: path.join(cwd, ".horde"), runDir, prompt: "do things", count: 1 };
  fs.mkdirSync(run.hordeDir, { recursive: true });

  const m = member.newMemberState(1);
  const controller = new AbortController();
  const promise = member.spawnMember({
    member: m,
    run,
    cwd,
    approve: false,
    signal: controller.signal,
    onChange: () => {},
  });

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(m.status, "running", "member should be running after agent_start");
  assert.equal(m.turns, 1);
  assert.equal(m.usage.input, 10);

  controller.abort(); // /agent-horde stop path
  await new Promise((r) => setTimeout(r, 6500)); // > KILL_GRACE_MS (5000)

  const pid = Number(fs.readFileSync(process.env.HORDE_TEST_PID_FILE, "utf-8"));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  const termSeen = fs.existsSync(process.env.HORDE_TEST_TERM_FILE);
  console.log(`child pid=${pid} alive_after_abort+6.5s=${alive} saw_SIGTERM=${termSeen}`);
  if (alive) {
    console.log("RESULT: SIGTERM escalation to SIGKILL did not happen");
    process.kill(pid, "SIGKILL");
  } else {
    console.log("RESULT: child died");
  }
  console.log("settled after kill:", await Promise.race([promise.then(() => "yes"), new Promise((r) => setTimeout(() => r("no"), 1000))]));
  process.exit(0);
}
