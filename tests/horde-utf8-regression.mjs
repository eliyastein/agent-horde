// Regression: spawnMember must decode UTF-8 across chunk boundaries without
// emitting U+FFFD, now that member.ts calls setEncoding("utf8").
// This file doubles as the fake `pi --mode json` child.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

if (process.argv.includes("--mode")) {
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "café ok" }],
      usage: { input: 1, output: 1, cost: { total: 0 } },
      stopReason: "stop",
    },
  };
  const bytes = Buffer.from(JSON.stringify(event) + "\n", "utf8");
  const splitAt = bytes.indexOf(Buffer.from("é", "utf8")) + 1; // split inside é (C3 | A9)
  process.stdout.write(bytes.subarray(0, splitAt));
  setTimeout(() => {
    process.stdout.write(bytes.subarray(splitAt));
    setTimeout(() => process.exit(0), 50);
  }, 50);
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

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-utf8-"));
  const runDir = path.join(cwd, "runs", "R1");
  fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "SYSTEM.md"), "protocol\n");
  fs.mkdirSync(path.join(cwd, ".horde"), { recursive: true });

  const m = member.newMemberState(1);
  await member.spawnMember({
    member: m,
    run: { id: "R1", hordeDir: path.join(cwd, ".horde"), runDir, prompt: "x", count: 1 },
    cwd,
    approve: false,
    signal: new AbortController().signal,
    onChange: () => {},
  });

  assert.equal(m.finalText, "café ok", `unexpected finalText: ${JSON.stringify(m.finalText)}`);
  assert.ok(!m.finalText.includes("\uFFFD"), "replacement character leaked into finalText");
  console.log("PASS: horde-utf8-regression");
}
