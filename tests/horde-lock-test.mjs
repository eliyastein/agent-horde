import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const ledger = {
  ...(await jiti.import("../src/ledger/board.ts")),
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/ideas.ts")),
};

const WRITERS = 8;
const PER_WRITER = 25;

if (process.argv[2] === "writer") {
  const [hordeDir, name] = process.argv.slice(3);
  const writer = (name.split("-")[1] ?? "0").padStart(2, "0");
  for (let i = 0; i < PER_WRITER; i++) {
    // One unique token per write so write-time dedup cannot merge the synthetic ideas.
    await ledger.addIdea(hordeDir, name, `probe${writer}x${String(i).padStart(2, "0")}y`);
    await ledger.postBoard(hordeDir, name, `${name} post ${i}`);
  }
  process.exit(0);
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-lock-"));
const hordeDir = ledger.initHordeDir(cwd);
const children = [];
for (let w = 1; w <= WRITERS; w++) {
  children.push(new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [process.argv[1], "writer", hordeDir, `member-${w}`], { stdio: "inherit" });
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}`))));
  }));
}
await Promise.all(children);

const doc = ledger.parseIdeas(fs.readFileSync(path.join(hordeDir, "IDEAS.md"), "utf-8"));
assert.equal(doc.ideas.size, WRITERS * PER_WRITER);
const ids = [...doc.ideas.keys()].sort((a, b) => a - b);
assert.deepEqual(ids, Array.from({ length: WRITERS * PER_WRITER }, (_, i) => i + 1));
const ideaLines = doc.lines.filter((l) => l.startsWith("- "));
assert.equal(ideaLines.length, WRITERS * PER_WRITER);
for (const line of ideaLines) assert.ok(ledger.parseIdeaLine(line), `bad line: ${line}`);
const boardText = fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf-8");
assert.equal((boardText.match(/^### /gm) ?? []).length, WRITERS * PER_WRITER);
assert.ok(!fs.existsSync(path.join(hordeDir, ".lock")));
console.log("PASS: horde-lock-test");
