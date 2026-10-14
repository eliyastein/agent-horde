import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";
// Sources import node:fs as ESM; syncBuiltinESMExports publishes the wrapper to them.
const cjsFs = createRequire(import.meta.url)("node:fs");
const realRead = cjsFs.readFileSync.bind(cjsFs);
let onRead;
cjsFs.readFileSync = (file, ...rest) => {
  const content = realRead(file, ...rest);
  onRead?.(String(file), content);
  return content;
};
syncBuiltinESMExports();
const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  "@earendil-works/pi-coding-agent": PI,
  "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
  "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
  typebox: `${DEPS}/typebox/build/index.mjs`,
} });
const { initHordeDir, hordePaths } = await jiti.import("../src/ledger/files.ts");
const { appendRunHeading } = await jiti.import("../src/ledger/board.ts");
const findings = await jiti.import("../src/ledger/findings.ts");
const { loadCollaborationReport } = await jiti.import("../src/collaboration-report.ts");
const { startSolvedWatch } = await jiti.import("../src/run/solved.ts");
fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-supersede-race-"));
const hordeDir = initHordeDir(cwd);
const id = "20261003-120000";
fs.mkdirSync(path.join(hordeDir, "runs", id), { recursive: true });
await appendRunHeading(hordeDir, id, "supersede race fixture");
const first = (await findings.addFinding(hordeDir, id, "member-1", "Parser drops trailing field at src/parse.ts", { concern: "parse", concernDef: "parser", concernNew: true })).finding;
await findings.addFinding(hordeDir, id, "member-2", "Lexer splits escaped quotes at src/lex.ts", { concern: "lex", concernDef: "lexer", concernNew: true });

// A member supersedes F1 between the report's first ledger read and any later read.
const findingsPath = path.resolve(hordePaths(hordeDir).findings);
let reads = 0;
onRead = (file, content) => {
  if (path.resolve(file) !== findingsPath || ++reads !== 1) return;
  const lines = String(content).split("\n");
  const heading = lines.findIndex((line) => line.startsWith("### ") && line.includes(`[F${first.id}]`));
  assert.ok(heading >= 0, "fixture finding heading not found");
  lines[heading] += " superseded=#F2";
  fs.writeFileSync(findingsPath, lines.join("\n"));
};
let report;
try {
  report = loadCollaborationReport(hordeDir, id);
} finally {
  onRead = undefined;
}
assert.ok(reads >= 1, "the report must read the findings ledger");
assert.ok(Array.isArray(report.issues));
assert.equal(findings.listFindingsForRun(hordeDir, id).find((f) => f.id === first.id)?.supersededBy, 2);

// Any later failure inside the solved poll is reported once instead of exiting pi.
const notices = [];
const broken = {
  get runDir() { throw new Error("ledger unreadable"); },
  ui: { notify: (message, level) => notices.push({ message, level }) },
};
startSolvedWatch(broken, {});
await new Promise((resolve) => setTimeout(resolve, 6_500));
clearInterval(broken.solvedTimer);
assert.equal(notices.length, 1, "a repeating failure must notify once");
assert.equal(notices[0].level, "error");
assert.match(notices[0].message, /solved check failed, retrying: Error: ledger unreadable/);
console.log("horde-supersede-race-regression: ok");
