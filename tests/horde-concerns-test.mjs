// Concern glossary: a finding's concern must be in CONCERNS.md. New slugs need a
// definition, look-alikes of an existing slug are refused unless the caller insists,
// legacy slugs already used by a finding pass, and deltas inherit their parent.
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
  ...(await jiti.import("../src/ledger/concerns.ts")),
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/findings.ts")),
  ...(await jiti.import("../src/ledger/ideas.ts")),
};

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-concerns-"));
const hordeDir = ledger.initHordeDir(cwd);
const concernsFile = path.join(hordeDir, "CONCERNS.md");
assert.ok(fs.existsSync(concernsFile), "initHordeDir writes CONCERNS.md");
assert.match(fs.readFileSync(concernsFile, "utf-8"), /^# Concerns/);
await ledger.appendRunHeading(hordeDir, "R1", "concerns probe");
const file = (author, text, meta) => ledger.addFinding(hordeDir, "R1", author, text, { support: "sourced", ...meta });

// A new slug without a definition is refused, and nothing is registered.
await assert.rejects(
  file("member-1", "Missing authz on query\nbody", { concern: "query-socketio-authz" }),
  /'query-socketio-authz' is a new concern; pass concernDef=/,
);
assert.deepEqual(ledger.listConcerns(hordeDir), []);
assert.equal(ledger.listFindingsForRun(hordeDir, "R1").length, 0, "a refused finding is not filed");

// With a definition it is registered with its author, and reuse needs no definition.
const first = await file("member-1", "Missing authz on query\nbody", {
  concern: "query-socketio-authz",
  concernDef: "socket.io query handler skips the authorization check",
});
assert.deepEqual(ledger.listConcerns(hordeDir), [
  { slug: "query-socketio-authz", definition: "socket.io query handler skips the authorization check", author: "member-1" },
]);
const reuse = await file("member-2", "Refund handler skips the role check\nPOST /refund with a viewer token succeeds", { concern: "query-socketio-authz" });
assert.equal(reuse.duplicateOf, undefined);
assert.equal(ledger.listConcerns(hordeDir).length, 1, "reuse does not add a glossary line");

// A reordered slug is a look-alike: refused with the existing slug named.
await assert.rejects(
  file("member-3", "Reordered\nbody", { concern: "socketio-query-authz", concernDef: "same thing again" }),
  /concern 'socketio-query-authz' looks like 'query-socketio-authz' \(socket\.io query handler skips the authorization check\); use concern query-socketio-authz/,
);
// A slug that only adds a word is a look-alike too.
await assert.rejects(
  file("member-3", "Extended\nbody", { concern: "query-socketio-authz-bypass", concernDef: "bypass variant" }),
  /looks like 'query-socketio-authz'/,
);
// A shared word plus a near-identical definition is a look-alike.
await assert.rejects(
  file("member-3", "Renamed\nbody", {
    concern: "socketio-handler-gap",
    concernDef: "socket.io query handler skips the authorization check entirely",
  }),
  /looks like 'query-socketio-authz'/,
);
// A different root cause on the same entry point is not a look-alike, but shared words are flagged.
const csrf = await file("member-2", "CSRF on the same handler\nno token check on the socket.io query", {
  concern: "query-socketio-csrf",
  concernDef: "socket.io query handler accepts cross-site requests",
});
assert.match(csrf.concernAdvisory, /'query-socketio-authz' \(query, socketio\)/, "shared slug words are advised, not refused");
assert.equal(ledger.listConcerns(hordeDir).length, 2);
// Insisting with concernNew registers it anyway.
await file("member-3", "Extended\nbody", {
  concern: "query-socketio-authz-bypass",
  concernDef: "authz present but bypassed through the bypass query flag",
  concernNew: true,
});
assert.equal(ledger.listConcerns(hordeDir).length, 3);
// Slugs with no word in common never match, even with template-like definitions.
const unrelated = await file("member-2", "Unrelated\nbody", {
  concern: "oauth-login-state",
  concernDef: "root cause: missing state check; entry point: oauth login callback",
});
assert.equal(ledger.listConcerns(hordeDir).length, 4);
assert.equal(unrelated.concernAdvisory, undefined);

// Deltas and corrections inherit the concern and need no definition.
await ledger.addIdea(hordeDir, "member-2", "delta idea");
const delta = await file("member-2", "Delta evidence\nmore", { concern: "query-socketio-authz", deltaOf: first.finding.id });
assert.equal(delta.finding.deltaOf, first.finding.id);
const correction = await file("member-2", "Correction\nthe handler is reachable unauthenticated", {
  concern: "query-socketio-authz", supersedes: first.finding.id,
});
assert.equal(correction.finding.supersedes, first.finding.id);

// A legacy concern that only exists in FINDINGS.md passes without a definition.
fs.appendFileSync(
  path.join(hordeDir, "FINDINGS.md"),
  "\n### 10:00:00 member-9 [F90] idea=#1 sev=low conf=low ev=inferred concern=legacy-cache-poison\nLegacy title\nlegacy body\n",
);
const legacy = await file("member-1", "Legacy follow-up\nnew evidence for the old concern", { concern: "legacy-cache-poison" });
assert.equal(legacy.duplicateOf, undefined);
assert.equal(ledger.listConcerns(hordeDir).length, 4, "a legacy slug is not re-registered");

// The tool action lists the glossary, and seedPlan leaves it alone.
const listed = await actions.runHordeAction(hordeDir, "member-1", { action: "concerns" }, "R1");
assert.match(listed.text, /^query-socketio-authz: socket\.io query handler skips the authorization check @member-1$/m);
assert.match(listed.text, /^oauth-login-state: .* @member-2$/m);
const before = fs.readFileSync(concernsFile, "utf-8");
await ledger.seedPlan(hordeDir, ["auth module", "billing module"]);
assert.equal(fs.readFileSync(concernsFile, "utf-8"), before, "plan layers do not seed concerns");

// The tool passes concernDef/concernNew through, and an empty glossary reads as such.
const empty = ledger.initHordeDir(fs.mkdtempSync(path.join(os.tmpdir(), "horde-concerns-empty-")));
const emptyList = await actions.runHordeAction(empty, "member-1", { action: "concerns" }, "R1");
assert.equal(emptyList.text, "CONCERNS.md has no concerns yet");
await ledger.appendRunHeading(empty, "R1", "tool probe");
const idea = await actions.runHordeAction(empty, "member-1", { action: "idea", text: "tool probe idea" }, "R1");
await actions.runHordeAction(empty, "member-1", { action: "claim", id: idea.id }, "R1");
await assert.rejects(
  actions.runHordeAction(empty, "member-1", {
    action: "finding", idea: idea.id, concern: "tool-probe-authz", support: "speculative", text: "Tool probe\nbody",
  }, "R1"),
  /is a new concern; pass concernDef=/,
);
const filed = await actions.runHordeAction(empty, "member-1", {
  action: "finding", idea: idea.id, concern: "tool-probe-authz", support: "speculative", text: "Tool probe\nbody",
  concernDef: "probe handler trusts the tool parameter",
}, "R1");
assert.match(filed.text, /Recorded finding F\d+ \[tool-probe-authz\]/);
assert.equal(ledger.listConcerns(empty)[0].slug, "tool-probe-authz");

// The synonym pair from run 20261005-225908 passed the gate; the advisory names the original.
await file("member-1", "Company overlap\nshared registry entries", {
  concern: "marlow-quill-company-overlap",
  concernDef: "companies where Marlow and Quill both hold positions",
});
const synonym = await file("member-2", "Partnership\njoint directorship records", {
  concern: "quill-marlow-partnership",
  concernDef: "business partnership between Quill and Marlow",
});
assert.match(synonym.concernAdvisory, /'marlow-quill-company-overlap' \((marlow, quill|quill, marlow)\)/);
const reused = await file("member-3", "Second partnership record\nanother filing", { concern: "quill-marlow-partnership" });
assert.equal(reused.concernAdvisory, undefined, "reusing a registered slug is not re-advised");
fs.rmSync(cwd, { recursive: true, force: true });
console.log("PASS: horde-concerns-test");
