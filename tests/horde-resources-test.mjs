// Resource registry + claim-time collision steering:
// - RESOURCES.md is created and the first claim owns a named shared artifact
// - a second member's claim returns the owner/pointer and records a reuser
// - a soft claim overlap succeeds with a warning naming the other slice
// - a hard overlap (same work, added before dedup could see it) is refused
// - plan seeding bypasses the overlap check
// - the report and dashboard expose resources
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti, DEPS, PI } from "./harness.mjs";

delete process.env.PI_HORDE_MEMBER;
const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": PI,
    "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
    "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
    typebox: `${DEPS}/typebox/build/index.mjs`,
  },
});
const ledger = {
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/ideas.ts")),
  ...(await jiti.import("../src/ledger/resources.ts")),
};
const actions = await jiti.import("../src/tool/actions.ts");
const board = await jiti.import("../src/ledger/board.ts");
const findings = await jiti.import("../src/ledger/findings.ts");
const data = await jiti.import("../src/dashboard-data.ts");
const dash = await jiti.import("../src/dashboard.ts");
const prompt = await jiti.import("../src/prompt.ts");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-resources-"));
const hordeDir = ledger.initHordeDir(cwd);
assert.ok(fs.existsSync(path.join(hordeDir, "RESOURCES.md")), "RESOURCES.md is created");
const run = (params) => actions.runHordeAction(hordeDir, "member-1", params, "R1");

// ---- resources: first claim owns, later claims reuse -----------------------
const first = await run({ action: "resource", text: "php8.2 lab", note: "docker php:8.2-cli, script .tmp/horde/R1/lab.sh" });
assert.match(first.text, /Claimed resource R1 "php8\.2 lab"/);
const again = await run({ action: "resource", text: "php8.2 lab", note: "other note" });
assert.match(again.text, /is already yours/);
const byOther = await actions.runHordeAction(hordeDir, "member-2", { action: "resource", text: "php 8.2 docker lab" }, "R1");
assert.match(byOther.text, /already claimed by member-1/, "near-identical name reuses the existing resource");
assert.match(byOther.text, /Reuse it instead of rebuilding/, "reuse is the instruction");
assert.match(byOther.text, /R1/);
const listed = await run({ action: "resources" });
assert.match(listed.text, /^R1 php8\.2 lab @member-1/);
assert.match(listed.text, /reuse=member-2/);
// Owner can update the pointer; a reuser cannot steal ownership.
const updated = await actions.runHordeAction(hordeDir, "member-1", { action: "resource", text: "php8.2 lab", note: "docker php:8.2-cli, lab.sh" }, "R1");
assert.match(updated.text, /is already yours/);
const stored = ledger.listResources(hordeDir)[0];
assert.equal(stored.owner, "member-1");
assert.equal(stored.note, "docker php:8.2-cli, lab.sh");
assert.deepEqual(stored.reusers, ["member-2"]);
// Round-trips through the file.
const raw = fs.readFileSync(path.join(hordeDir, "RESOURCES.md"), "utf-8");
assert.match(raw, /^- \[R1\] php8\.2 lab {2}@member-1: docker php:8\.2-cli, lab\.sh {2}reuse=member-2 {2}origin=R1$/m);
const second = await actions.runHordeAction(hordeDir, "member-3", { action: "resource", text: "control corpus 4 hosts" }, "R1");
assert.match(second.text, /Claimed resource R2/);
assert.equal(ledger.listResources(hordeDir).length, 2);

// ---- claim overlap: soft warning (two shared terms, one topic) -------------
const a = await ledger.addIdea(hordeDir, "member-1", "probe cloakwise parameter content flip");
const b = await ledger.addIdea(hordeDir, "member-2", "verify cloakwise parameter header alpha");
assert.notEqual(a.idea.id, b.idea.id, "the two ideas passed write-time dedup");
const claimA = await actions.runHordeAction(hordeDir, "member-1", { action: "claim", id: a.idea.id }, "R1");
assert.match(claimA.text, /Claimed #\d+/);
assert.ok(!/Warning:/.test(claimA.text), "first claim has nothing to collide with");
const claimB = await actions.runHordeAction(hordeDir, "member-2", { action: "claim", id: b.idea.id }, "R1");
assert.match(claimB.text, /Claimed #\d+/, "a similar claim still succeeds");
assert.match(claimB.text, /Warning: #\d+ held by member-1 covers a similar slice/, "and warns with the holder");

// ---- claim overlap: decisive refusal (same slice, different wording) -------
const cwd2 = path.join(cwd, "second");
fs.mkdirSync(cwd2);
const hordeDir2 = ledger.initHordeDir(cwd2);
const h1 = await ledger.addIdea(hordeDir2, "member-3", "probe cloakwise c parameter content type flip");
const h2 = await ledger.addIdea(hordeDir2, "member-4", "verify cloakwise c parameter header flip behaviour");
assert.notEqual(h1.idea.id, h2.idea.id, "the hard-overlap pair passed write-time dedup");
await actions.runHordeAction(hordeDir2, "member-3", { action: "claim", id: h1.idea.id }, "R1");
await assert.rejects(
  actions.runHordeAction(hordeDir2, "member-4", { action: "claim", id: h2.idea.id }, "R1"),
  /same work as #\d+ held by member-3/,
  "the same slice worded differently is refused at claim time",
);

// ---- claim overlap: identical text (bypassing addIdea by editing the file) --
fs.writeFileSync(
  path.join(hordeDir, "IDEAS.md"),
  ["# Ideas", "", "- [ ] #90 method matrix oracle probe", "- [ ] #91 method matrix oracle probe", ""].join("\n"),
);
await ledger.claimIdea(hordeDir, "member-1", 90);
await assert.rejects(
  ledger.claimIdea(hordeDir, "member-2", 91),
  /same work as #90 held by member-1/,
  "identical work already held is refused at claim time",
);
// The refused claim rules out the losing idea, linked to the winner, so it is not
// left as an open orphan that coverage counts forever.
const ruled91 = ledger.listIdeas(hordeDir).find((i) => i.id === 91);
assert.equal(ruled91.mark, "!", "a refused-claim orphan is ruled out");
assert.match(ruled91.note ?? "", /dup of #90/, "the rule-out links the winning idea");
// Plan seeding opts out of the overlap check (on a fresh idea, not the ruled-out dup).
fs.appendFileSync(path.join(hordeDir, "IDEAS.md"), "- [ ] #92 method matrix oracle probe\n");
await assert.doesNotReject(ledger.claimIdea(hordeDir, "member-3", 92, { checkOverlap: false }));
assert.equal(ledger.listIdeas(hordeDir).find((i) => i.id === 92).owner, "member-3");

// ---- report and dashboard expose resources --------------------------------
const report = prompt.runReportMarkdown({
  id: "R1",
  prompt: "p",
  count: 1,
  members: [ledger.listIdeas(hordeDir) && { name: "member-1", index: 1, status: "done", turns: 1, toolCalls: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, lastText: "", finalText: "", startedAt: Date.now() }],
  startedAt: Date.now(),
  stopped: false,
  outcome: "completed",
  findings: [],
  clusters: [],
  claims: [],
  facts: [],
  resources: ledger.listResources(hordeDir),
});
assert.match(report, /- resources: 2 claimed, 1 reused \(1 explicit reclaim\(s\), 0 citing member\(s\)\)/);
assert.match(report, /## Resources/);
assert.match(report, /- R1 php8\.2 lab @member-1: docker php:8\.2-cli, lab\.sh \(reused by member-2\)/);

const source = { hordeDir, getActive: () => undefined };
assert.equal(data.loadResources(source).resources.length, 2);
const res = dash.routeRequest(source, "GET", new URL("http://127.0.0.1/resources"), "127.0.0.1");
assert.equal(res.status, 200);
assert.ok(res.body.includes("php8.2 lab"), "resources page lists the name");
assert.ok(res.body.includes("member-2"), "resources page lists the reuser");
assert.ok(res.body.includes("needs an active run"), "without an active run only reclaims are known");
const api = dash.routeRequest(source, "GET", new URL("http://127.0.0.1/api/resources"), "127.0.0.1");
assert.equal(api.status, 200);
const vm = JSON.parse(api.body);
assert.equal(vm.resources.length, 2);
assert.deepEqual(vm.resources[0].reusers, ["member-2"]);
assert.deepEqual(vm.resources[0].citedBy, [], "citations need an active run");

// ---- the dashboard counts reuse by citation for the active run, as REPORT.md does ------------
const runId = "20261018-130001";
const runDir = path.join(hordeDir, "runs", runId);
fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 3\n");
await board.appendRunHeading(hordeDir, runId, "resource citation fixture");
await findings.addFinding(hordeDir, runId, "member-3", "Root chown follows a planted link, reproduced in R1", { concern: "planted-link", concernDef: "chown", concernNew: true });
const live = { hordeDir, getActive: () => ({ id: runId, hordeDir, runDir }) };
const liveVm = data.loadResources(live);
assert.equal(liveVm.run, runId);
assert.deepEqual(liveVm.resources[0].citedBy, ["member-3"], "a non-owner finding that names R1 counts as reuse");
assert.deepEqual(liveVm.resources[0].reusers, ["member-2"], "explicit reclaims stay separate");
assert.deepEqual(liveVm.resources[1].citedBy, []);
const livePage = dash.routeRequest(live, "GET", new URL("http://127.0.0.1/resources"), "127.0.0.1");
assert.ok(livePage.body.includes("cited by"), "the resources page has a cited-by column");
assert.ok(livePage.body.includes("member-3"), "the citing member is listed");

fs.rmSync(cwd, { recursive: true, force: true });
console.log("PASS: horde-resources-test");
