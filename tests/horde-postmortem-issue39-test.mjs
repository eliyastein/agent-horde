// Regression for issue #39: a deliverable that cites an existing run directory as
// `runs/<id>/artifacts/<dir>/` was warned that the path does not exist, because the check never
// resolved paths against the horde directory and its basename fallback matches files only.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  "@earendil-works/pi-coding-agent": PI,
  "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
  "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
  typebox: `${DEPS}/typebox/build/index.mjs`,
} });
const files = await jiti.import("../src/ledger/files.ts");
const citations = await jiti.import("../src/citations.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue39-"));
const layouts = [
  ["single run", files.initHordeDir(cwd)],
  ["swarm horde", path.join(cwd, ".horde/swarms/20261101-230605/h2")],
];
for (const [layout, hordeDir] of layouts) {
  const id = "20261101-230605-h2";
  const runDir = path.join(hordeDir, "runs", id);
  fs.mkdirSync(path.join(runDir, "artifacts/early-handlers"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "artifacts/early-handlers/verify_early_handlers.py"), "print('ok')\n");
  const run = { id, hordeDir, runDir, cwd };
  const missing = (ref) => citations.generatedArtifactWarnings(run, "DELIVERABLE.md", `See \`${ref}\`.`, [])
    .includes(`DELIVERABLE.md cites a path that does not exist: ${ref}`);
  for (const ref of [`runs/${id}/artifacts/early-handlers/`, `runs/${id}/artifacts/early-handlers`, `runs/${id}/artifacts/early-handlers/verify_early_handlers.py`]) {
    assert.equal(missing(ref), false, `${layout}: existing ${ref} is not reported missing`);
  }
  for (const ref of [`runs/${id}/artifacts/tail-handlers/`, `runs/${id}/artifacts/missing.py`]) {
    assert.equal(missing(ref), true, `${layout}: absent ${ref} is still reported`);
  }
}

console.log("issue 39 regression passed");
