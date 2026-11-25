// A second run in one directory sees the first run's findings in FINDINGS.md. Linking to one
// with deltaOf, supersedes or attach is refused with an error that names the earlier run and
// says how to cite it; naming it in the text of a new finding works.
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
const actions = await jiti.import("../src/tool/actions.ts");
const ledger = {
  ...(await jiti.import("../src/ledger/board.ts")),
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/findings.ts")),
};

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-cross-run-"));
const hordeDir = ledger.initHordeDir(cwd);
const meta = { support: "sourced", concern: "host-map", concernDef: "Hosts the operator runs." };
await ledger.appendRunHeading(hordeDir, "R1", "first run");
const old = await ledger.addFinding(hordeDir, "R1", "member-1", "Host map\nthree hosts", meta);
await ledger.appendRunHeading(hordeDir, "R2", "second run");
fs.mkdirSync(path.join(hordeDir, "runs", "R2"), { recursive: true });
const id = old.finding.id;

await assert.rejects(
  ledger.addFinding(hordeDir, "R2", "member-2", "Fourth host\nnew name", { ...meta, deltaOf: id }),
  new RegExp(`finding F${id} was filed in earlier run R1 and is closed; deltaOf links findings of run R2 only\\. File this as a new finding without deltaOf and name F${id} in its text`),
);
await assert.rejects(
  ledger.addFinding(hordeDir, "R2", "member-2", "Corrected map\ntwo hosts", { ...meta, supersedes: id }),
  /was filed in earlier run R1 and is closed; supersedes links findings of run R2 only/,
);
await assert.rejects(
  ledger.addFinding(hordeDir, "R2", "member-2", "Fourth host\nnew name", { ...meta, deltaOf: 99 }),
  /finding F99 does not exist; deltaOf must reference a finding in run R2/,
);
assert.equal(ledger.earlierRunOfFinding(hordeDir, "R2", id), "R1");
assert.equal(ledger.earlierRunOfFinding(hordeDir, "R1", id), undefined, "a finding of the asking run is not earlier");
assert.equal(ledger.earlierRunOfFinding(hordeDir, "R2", 99), undefined);

await assert.rejects(
  actions.runHordeAction(hordeDir, "member-2", { action: "attach", target: `F${id}`, text: "fourth host resolves" }, "R2"),
  new RegExp(`F${id} was filed in earlier run R1 and is closed to evidence, reviews and messages; file a finding in this run and name F${id} in its text`),
);
await assert.rejects(
  actions.runHordeAction(hordeDir, "member-2", { action: "attach", target: "F99", text: "x" }, "R2"),
  /unknown target F99/,
);

const cited = await ledger.addFinding(hordeDir, "R2", "member-2", `Fourth host beyond F${id}\na name the F${id} map lacks`, meta);
assert.equal(cited.finding.runId, "R2");
const own = await ledger.addFinding(hordeDir, "R2", "member-3", "Fifth host\nmore evidence", { ...meta, deltaOf: cited.finding.id });
assert.equal(own.finding.deltaOf, cited.finding.id, "a delta of this run's finding still works");

fs.rmSync(cwd, { recursive: true, force: true });
console.log("PASS: horde-cross-run-refs-test");
