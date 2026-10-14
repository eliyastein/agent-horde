// Regression: spawnMember must survive a log write-stream error.
// Fake child pi mode when "--mode" is in argv.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

if (process.argv.includes("--mode")) {
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  setTimeout(() => process.exit(0), 200);
} else {
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

  const crashes = [];
  process.on("uncaughtException", (e) => crashes.push(`${e.code ?? e.name}: ${e.message}`));

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "m1-logerr-"));
  const runDir = path.join(cwd, "runs", "R-gone"); // deliberately never created
  const run = { id: "R-gone", hordeDir: path.join(cwd, ".horde"), runDir, prompt: "x", count: 1 };
  fs.mkdirSync(run.hordeDir, { recursive: true });

  const m = member.newMemberState(1);
  const controller = new AbortController();
  const p = member.spawnMember({
    member: m,
    run,
    cwd,
    approve: false,
    signal: controller.signal,
    onChange: () => {},
  });

  await new Promise((r) => setTimeout(r, 1500));
  console.log("member status:", m.status, "exit:", m.exitCode);
  console.log("uncaughtExceptions:", crashes);
  console.log("RESULT unhandled log-stream error crashes the parent:", crashes.length > 0);
  void p;
  process.exit(0);
}
