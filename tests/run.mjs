// Runs the agent-horde test suite: every *-test.mjs and *-regression.mjs in its own process.
// Usage: node tests/run.mjs
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(dir)
  .filter((name) => /-(test|regression)\.mjs$/.test(name))
  .sort();

let failed = 0;
for (const file of files) {
  process.stdout.write(`${file.padEnd(36)} `);
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(dir, file)], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 300_000,
  });
  const ms = Date.now() - started;
  if (result.status === 0) {
    console.log(`PASS ${ms}ms`);
    continue;
  }
  failed++;
  console.log(`FAIL(${result.status ?? "signal"}) ${ms}ms`);
  const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-8);
  if (tail.length > 0) console.log(tail.map((line) => `    ${line}`).join("\n"));
}

console.log(`\n${files.length - failed}/${files.length} passed`);
process.exit(failed === 0 ? 0 : 1);
