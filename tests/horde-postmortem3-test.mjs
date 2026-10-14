// Post-mortem round 3 fixes:
// - path citation extraction is conservative (no AND/OR, ratios, host paths, repo slugs)
// - `delta-of` facts and findings cannot restate their parent to bypass dedup
// - `unverifiedFindings` exposes the pending verification queue
// - a killed member's summary is reconstructed from its last board post
// - the report carries an unverified list and a contested-solve outcome
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
const citations = await jiti.import("../src/citations.ts");
const ledger = {
  ...(await jiti.import("../src/ledger/board.ts")),
  ...(await jiti.import("../src/ledger/clusters.ts")),
  ...(await jiti.import("../src/ledger/facts.ts")),
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/findings.ts")),
};
const prompt = await jiti.import("../src/prompt.ts");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-pm3-"));
const hordeDir = ledger.initHordeDir(cwd);
await ledger.appendRunHeading(hordeDir, "R1", "postmortem3 probe");
const file = (author, text, meta) =>
  ledger.addFinding(hordeDir, "R1", author, text, { support: "sourced", ...meta });

// ---- path extraction is conservative ----------------------------------------
const refs = citations.citedDataFiles(
  "see `AND/OR`, `input/output`, `tokens/second`, `2/3`, github.com/foo/bar, " +
    "`docs.example.com/llms.txt`, `artifacts-m1/jev_envelope/traps_output.json`, " +
    "`SUMMARY.md`, `artifacts-m3/red`, and `1.00/1.00`.",
);
for (const prose of ["AND/OR", "input/output", "tokens/second", "2/3", "1.00/1.00"]) {
  assert.ok(!refs.includes(prose), `prose "${prose}" must not count as a path`);
}
for (const url of ["github.com/foo/bar", "docs.example.com/llms.txt"]) {
  assert.ok(!refs.includes(url), `host path "${url}" must not count as a local path`);
}
assert.ok(refs.includes("artifacts-m1/jev_envelope/traps_output.json"), "an artifact path is checked");
assert.ok(refs.includes("SUMMARY.md"), "a bare data filename is checked");
assert.ok(refs.includes("artifacts-m3/red"), "a path rooted at a run artifact dir is checked");

// Remote/target paths, globs, and placeholders are not local artifacts to check.
const noise = citations.citedDataFiles(
  "the target ships `installed.php` and `content/plugins/ruya-artists/ruya-artists.php`; " +
    "harnesses under `.horde/runs/20260923-085455/artifacts/member-{1..6}/` cite " +
    "`.horde/runs/$RUN/artifacts/member-6/verify_f9.php`, and member-1 wrote " +
    "`.horde/runs/R1/artifacts/member-1/router.php`.",
);
for (const remote of ["installed.php", "content/plugins/ruya-artists/ruya-artists.php"]) {
  assert.ok(!noise.includes(remote), `remote source path "${remote}" must not be checked`);
}
assert.ok(
  !noise.some((ref) => ref.includes("member-{") || ref.endsWith("artifacts/member-")),
  "a brace-glob prefix must not be checked",
);
assert.ok(!noise.some((ref) => ref.includes("$")), "an unexpanded placeholder must not be checked");
assert.ok(
  noise.includes(".horde/runs/R1/artifacts/member-1/router.php"),
  "a source artifact under a run root is still checked",
);

// ---- delta facts cannot bypass dedup ----------------------------------------
const f1 = await ledger.addFact(hordeDir, "member-1", "the API key is absent from the environment");
const deltaDup = await ledger.addFact(
  hordeDir,
  "member-2",
  "the API key is absent from the environment",
  f1.fact.id,
);
assert.equal(deltaDup.duplicateOf?.id, f1.fact.id, "a delta restating its parent accretes");
assert.equal(ledger.listFacts(hordeDir).length, 1, "the restated delta adds no fact row");
const deltaNew = await ledger.addFact(
  hordeDir,
  "member-3",
  "the model alias jev-latest resolved to jev-1.13.0 at fetch time",
  f1.fact.id,
);
assert.equal(deltaNew.fact.deltaOf, f1.fact.id, "a genuinely distinct delta still attaches");
assert.equal(ledger.listFacts(hordeDir).length, 2);

// ---- evidence wording alone cannot justify dropping a finding delta --------
const base = await file("member-1", "the endpoint returns 200 with a viewer token", {
  concern: "endpoint-authz",
  concernDef: "endpoint role check",
});
const similar = await file("member-2", "the endpoint returns 200 with a viewer token", {
  concern: "endpoint-authz", deltaOf: base.finding.id,
});
assert.equal(similar.finding.deltaOf, base.finding.id);

// ---- pending verification queue ---------------------------------------------
const delta = await file("member-3", "the endpoint also accepts an expired token", {
  concern: "endpoint-authz",
  deltaOf: base.finding.id,
});
assert.equal(ledger.unverifiedFindings(hordeDir, "R1").length, 3, "all live findings are pending");
const findings = ledger.listFindingsForRun(hordeDir, "R1");

// ---- report carries the unverified list and contested outcome ---------------
const member = (name) => ({
  name,
  index: 1,
  status: "done",
  turns: 1,
  toolCalls: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
  lastText: "",
  finalText: "",
  startedAt: 0,
});
const members = [member("member-1"), member("member-2"), member("member-3")];
const clusters = ledger.clusterFindings(findings);
const report = prompt.runReportMarkdown({
  id: "R1",
  prompt: "postmortem3 probe",
  count: 3,
  members,
  startedAt: 0,
  stopped: false,
  outcome: "completed",
  findings,
  clusters,
  claims: [],
  facts: [],
});
assert.match(report, /- unverified findings: F\d+, F\d+/);
assert.match(report, / unverified /, "each unreproduced finding is marked unverified");
const contested = prompt.runReportMarkdown({
  id: "R1",
  prompt: "postmortem3 probe",
  count: 3,
  members,
  startedAt: 0,
  stopped: true,
  outcome: "solved-contested",
  solvedContested: true,
  findings: [],
  clusters: [],
  claims: [],
  facts: [],
});
assert.match(contested, /^- outcome: solved-contested$/m);
assert.match(contested, /- solved: contested; no validated answer survived the run/);

// ---- a killed member's summary comes from its last board post ---------------
const killed = {
  ...member("member-1"),
  status: "stopped",
  endCause: "killed",
  summaryIncomplete: true,
  draftText: "the LessWrong Control",
  finalText: "",
};
const summary = prompt.summaryMarkdown({
  id: "R1",
  prompt: "postmortem3 probe",
  count: 1,
  members: [killed],
  startedAt: 0,
  stopped: true,
  memberPosts: new Map([["member-1", "Final board conclusion: the control held."]]),
});
assert.match(summary, /summary unavailable; reconstructed from the member's last board post/);
assert.match(summary, /Final board conclusion: the control held\./);
assert.doesNotMatch(summary, /the LessWrong Control/, "the mid-sentence draft is not printed as a summary");

// ---- verifying one finding removes it from the queue ------------------------
await ledger.verifyFinding(hordeDir, "R1", "member-2", { id: base.finding.id, support: "reproduced", text: "ran it end to end" });
const pending = ledger.unverifiedFindings(hordeDir, "R1");
assert.deepEqual(pending.map((finding) => finding.id), [similar.finding.id, delta.finding.id]);

fs.rmSync(cwd, { recursive: true, force: true });
console.log("PASS: horde-postmortem3-test");
process.exit(0);
