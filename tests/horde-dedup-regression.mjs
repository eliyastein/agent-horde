// Regression: the parallel-startup idea burst must not create duplicates.
// No read-then-add ordering can help when every member reads at t=0, so the
// write-time check in addIdea is the guarantee.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const ledger = {
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/ideas.ts")),
};

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-dedup-"));
const hordeDir = ledger.initHordeDir(cwd);

// Three members race to add paraphrases of one idea, plus one distinct idea.
const results = await Promise.all([
  ledger.addIdea(hordeDir, "member-1", "audit the lock acquire and release path"),
  ledger.addIdea(hordeDir, "member-2", "audit the lock acquire release path"),
  ledger.addIdea(hordeDir, "member-3", "lock acquire release path audit"),
  ledger.addIdea(hordeDir, "member-3", "check UTF-8 chunk handling"),
]);

const ideas = ledger.listIdeas(hordeDir);
assert.equal(ideas.length, 2, `expected 2 ideas, got ${JSON.stringify(ideas)}`);
const deduped = results.filter((r) => r.duplicateOf).length;
assert.equal(deduped, 2, "the two later paraphrases must be reported as duplicates");
const ids = results.map((r) => r.idea.id);
assert.equal(new Set(ids.slice(0, 3)).size, 1, `parallel paraphrases got distinct ids: ${ids}`);
assert.notEqual(ids[3], ids[0], "the distinct idea must get its own id");
console.log("PASS: horde-dedup-regression");
