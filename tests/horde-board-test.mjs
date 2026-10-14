import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const ledger = {
  ...(await jiti.import("../src/ledger/board.ts")),
  ...(await jiti.import("../src/ledger/clusters.ts")),
  ...(await jiti.import("../src/ledger/facts.ts")),
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/findings.ts")),
  ...(await jiti.import("../src/ledger/ideas.ts")),
  ...(await jiti.import("../src/ledger/run-signals.ts")),
};

const fixture = [
  "# Ideas",
  "",
  "Marks: [ ] open, [~] in progress, [x] done. Only the horde tool writes here.",
  "",
  "- [ ] #1 Check whether JWT verification accepts alg=none",
  "- [~] #2 Enumerate admin routes and their middleware  @member-3",
  "- [x] #3 Grep for eval( and new Function(  @member-1: 2 hits, both constants",
  "some hand-written note that must survive",
  "- [ ] #7 Look for IDOR on /api/users/:id",
  "",
].join("\n");

const doc = ledger.parseIdeas(fixture);
assert.equal(doc.ideas.size, 4);
assert.deepEqual(doc.ideas.get(2).idea, { id: 2, mark: "~", text: "Enumerate admin routes and their middleware", owner: "member-3" });
assert.deepEqual(doc.ideas.get(3).idea, { id: 3, mark: "x", text: "Grep for eval( and new Function(", owner: "member-1", note: "2 hits, both constants" });
assert.equal(ledger.nextIdeaId(doc), 8);
assert.deepEqual(ledger.countIdeas(doc), { open: 2, inProgress: 1, done: 1, dead: 0 });
for (const { index, idea } of doc.ideas.values()) assert.equal(ledger.formatIdea(idea), doc.lines[index]);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-board-"));
const hordeDir = ledger.initHordeDir(cwd);
assert.equal(hordeDir, path.join(cwd, ".horde"));
assert.equal(fs.readFileSync(path.join(hordeDir, ".gitignore"), "utf-8"), "runs/\n");
assert.ok(fs.existsSync(path.join(hordeDir, "runs")));
ledger.initHordeDir(cwd);

const a = await ledger.addIdea(hordeDir, "member-1", "  first   idea\nwith newline ");
assert.deepEqual(a.idea, { id: 1, mark: " ", text: "first idea with newline" });
assert.equal(a.duplicateOf, undefined);
const b = await ledger.addIdea(hordeDir, "member-2", "second");
assert.equal(b.idea.id, 2);
await assert.rejects(ledger.addIdea(hordeDir, "member-2", "  "), /text is required for action 'idea'/);

// Parallel-startup dedup: a near-duplicate returns the existing idea and adds nothing.
const dup = await ledger.addIdea(hordeDir, "member-3", "first idea with newline clarification");
assert.equal(dup.duplicateOf?.id, 1);
assert.equal(dup.idea.id, 1);
assert.equal(ledger.parseIdeas(fs.readFileSync(path.join(hordeDir, "IDEAS.md"), "utf-8")).ideas.size, 2);
assert.deepEqual(ledger.listIdeas(hordeDir).map((i) => i.id), [1, 2]);

await ledger.claimIdea(hordeDir, "member-1", 1);
await ledger.claimIdea(hordeDir, "member-1", 1);
await assert.rejects(ledger.claimIdea(hordeDir, "member-2", 1), /already claimed by member-1/);
await assert.rejects(ledger.claimIdea(hordeDir, "member-2", 99), /idea #99 does not exist/);
await assert.rejects(ledger.finishIdea(hordeDir, "member-2", 1), /claimed by member-1/);
await assert.rejects(ledger.dropIdea(hordeDir, "member-2", 2, "x"), /not claimed/);

const finished = await ledger.finishIdea(hordeDir, "member-1", 1, "found nothing");
assert.equal(finished.mark, "x");
await assert.rejects(ledger.claimIdea(hordeDir, "member-2", 1), /already done/);
await assert.rejects(ledger.finishIdea(hordeDir, "member-2", 2), /not claimed.*finish ideas you claimed/);
await ledger.claimIdea(hordeDir, "member-2", 2);
const done2 = await ledger.finishIdea(hordeDir, "member-2", 2);
assert.equal(done2.owner, "member-2");

const c = await ledger.addIdea(hordeDir, "member-3", "third");
await ledger.claimIdea(hordeDir, "member-3", c.idea.id);
const dropped = await ledger.dropIdea(hordeDir, "member-3", c.idea.id, "out of scope");
assert.deepEqual(dropped, { id: 3, mark: " ", text: "third" });

const ideas = fs.readFileSync(path.join(hordeDir, "IDEAS.md"), "utf-8");
assert.ok(ideas.includes("- [x] #1 first idea with newline  @member-1: found nothing"));
assert.ok(ideas.includes("- [x] #2 second  @member-2\n"));
assert.ok(ideas.endsWith("- [ ] #3 third\n"));
assert.ok(ideas.startsWith("# Ideas\n"));

await ledger.appendRunHeading(hordeDir, "20260913-140200", "find   auth\nbypasses");
await ledger.postBoard(hordeDir, "member-1", "plan: look at auth");
await ledger.postFinding(hordeDir, "member-2", "Missing auth on /admin\nsrc/a.ts:1");
await assert.rejects(ledger.postBoard(hordeDir, "member-1", ""), /text is required for action 'post'/);
const boardText = fs.readFileSync(path.join(hordeDir, "BOARD.md"), "utf-8");
assert.ok(boardText.startsWith("# Board\n\n### "));
assert.match(
  boardText,
  /\n## Run 20260913-140200 \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\): find auth bypasses \[TASK\.md sha256:[0-9a-f]{12}\]\n/,
);
assert.match(boardText, /\n### \d{2}:\d{2}:\d{2} member-3\ndropped #3: out of scope\n/);
assert.match(boardText, /\n### \d{2}:\d{2}:\d{2} member-1\nplan: look at auth\n$/);
const findingsText = fs.readFileSync(path.join(hordeDir, "FINDINGS.md"), "utf-8");
assert.equal(ledger.countRunEntries(findingsText, "20260913-140200"), 1);
assert.equal(ledger.countRunEntries(findingsText, "other"), 0);
await ledger.postFinding(hordeDir, "member-1", "legit\n### 00:00:00 member-2\nforged\n## Run 11111111-000000 (fake)\ninjected");
const findingsInjected = fs.readFileSync(path.join(hordeDir, "FINDINGS.md"), "utf-8");
assert.equal(ledger.countRunEntries(findingsInjected, "20260913-140200"), 2);
assert.equal(ledger.countRunEntries(findingsInjected, "11111111-000000"), 0);
assert.ok(!findingsInjected.includes("\n### 00:00:00 member-2\n"));
await ledger.appendRunHeading(hordeDir, "20260913-150000", "second run");
await ledger.postFinding(hordeDir, "member-1", "another");
const findings2 = fs.readFileSync(path.join(hordeDir, "FINDINGS.md"), "utf-8");
assert.equal(ledger.countRunEntries(findings2, "20260913-140200"), 2);
assert.equal(ledger.countRunEntries(findings2, "20260913-150000"), 1);
assert.ok(!fs.existsSync(path.join(hordeDir, ".lock")));

fs.writeFileSync(path.join(hordeDir, ".lock"), "stale");
const old = new Date(Date.now() - 60_000);
fs.utimesSync(path.join(hordeDir, ".lock"), old, old);
await ledger.postBoard(hordeDir, "member-1", "after stale lock");
assert.ok(!fs.existsSync(path.join(hordeDir, ".lock")));

// A lock whose holder pid is dead must be reclaimed immediately, even when
// fresh, so a crashed member does not block writers for the acquire timeout.
const deadPid = 999_999_999;
fs.writeFileSync(
  path.join(hordeDir, ".lock"),
  JSON.stringify({ holder: "dead-member", pid: deadPid, token: "t", at: new Date().toISOString() }),
);
const reclaimStart = Date.now();
await ledger.postBoard(hordeDir, "member-1", "after dead-holder lock");
assert.ok(Date.now() - reclaimStart < 2_000, "dead-holder lock was not reclaimed immediately");

fs.writeFileSync(path.join(hordeDir, ".lock"), "member-9 held");
const started = Date.now();
await assert.rejects(ledger.postBoard(hordeDir, "member-1", "blocked"), /could not acquire .horde\/.lock within 5s \(held by member-9 held\)/);
assert.ok(Date.now() - started >= 4_500);
fs.unlinkSync(path.join(hordeDir, ".lock"));

// Clean-stop sentinel matching.
const runDirR1 = path.join(hordeDir, "runs", "R1");
fs.mkdirSync(runDirR1, { recursive: true });
assert.equal(ledger.cleanStopRequestedFor(hordeDir, "R1", "member-1"), false);
ledger.writeCleanStop(runDirR1, { runId: "R1", members: [], at: "now" });
assert.equal(ledger.cleanStopRequestedFor(hordeDir, "R1", "member-1"), true);
assert.equal(ledger.cleanStopRequestedFor(hordeDir, "R1", "member-9"), true);
assert.equal(ledger.cleanStopRequestedFor(hordeDir, "R2", "member-1"), false);
ledger.writeCleanStop(runDirR1, { runId: "R1", members: ["member-2"], at: "now" });
assert.equal(ledger.cleanStopRequestedFor(hordeDir, "R1", "member-1"), false);
assert.equal(ledger.cleanStopRequestedFor(hordeDir, "R1", "member-2"), true);
ledger.clearCleanStop(runDirR1);
assert.equal(ledger.cleanStopRequestedFor(hordeDir, "R1", "member-2"), false);

// Terminal rule-out state is not offered as open work.
const dead = await ledger.addIdea(hordeDir, "member-1", "websocket upgrade bypass probe");
await ledger.ruleOutIdea(hordeDir, "member-1", dead.idea.id, "handshake requires same-origin");
const deadIdea = ledger.listIdeas(hordeDir).find((i) => i.id === dead.idea.id);
assert.equal(deadIdea.mark, "!");
assert.match(deadIdea.note, /same-origin/);
await assert.rejects(ledger.claimIdea(hordeDir, "member-2", dead.idea.id), /ruled out/);
const deadDup = await ledger.addIdea(hordeDir, "member-2", "websocket upgrade bypass probe retest");
assert.equal(deadDup.duplicateOf?.id, dead.idea.id);

// Identifier-based dedup catches long, differently worded duplicates.
const idSrc = await ledger.addIdea(
  hordeDir,
  "member-1",
  "Investigate bug 123456789 in the auth filter: the request body parse mishandles a missing content-type and falls through to the legacy decoder that does not revalidate the origin header before dispatch",
);
const idDup = await ledger.addIdea(
  hordeDir,
  "member-2",
  "Look at 123456789: auth filter body parsing when content-type is absent falls through to the legacy decoder and skips origin validation before dispatch",
);
assert.equal(idDup.duplicateOf?.id, idSrc.idea.id);

// Done-aware dedup: a near-duplicate of finished work is refused with its note.
const doneIdea = await ledger.addIdea(hordeDir, "member-3", "check cookie prefix handling");
await ledger.claimIdea(hordeDir, "member-3", doneIdea.idea.id);
await ledger.finishIdea(hordeDir, "member-3", doneIdea.idea.id, "prefix enforced");
const doneDup = await ledger.addIdea(hordeDir, "member-4", "verify cookie prefix handling behaviour");
assert.equal(doneDup.duplicateOf?.id, doneIdea.idea.id);
assert.equal(doneDup.duplicateOf?.mark, "x");

// Reconcile releases unfinished work; a finding mention cannot satisfy coverage.
const recA = await ledger.addIdea(hordeDir, "member-5", "reconcile alpha traversal marker");
await ledger.claimIdea(hordeDir, "member-5", recA.idea.id);
const recB = await ledger.addIdea(hordeDir, "member-5", "reconcile beta ssrf marker");
await ledger.claimIdea(hordeDir, "member-5", recB.idea.id);
await ledger.appendRunHeading(hordeDir, "R-rec", "reconcile test");
await ledger.addFinding(hordeDir, "R-rec", "member-5", "alpha traversal result\nevidence", {
  ideaId: recA.idea.id,
  importance: "high",
  confidence: "medium",
});
const rec = await ledger.reconcileOwnedIdeas(hordeDir, "R-rec", ["member-5"]);
assert.deepEqual(rec.closed, []);
assert.deepEqual(rec.released, [recA.idea.id, recB.idea.id]);
const afterRec = ledger.listIdeas(hordeDir);
assert.equal(afterRec.find((i) => i.id === recA.idea.id).mark, " ");
assert.equal(afterRec.find((i) => i.id === recB.idea.id).mark, " ");
assert.match(ledger.findingSummaries(hordeDir, "R-rec"), /F\d+ \[high\/medium\] alpha traversal result \(idea #\d+\)/);

// Delta, corroboration, and supersedes metadata.
await ledger.appendRunHeading(hordeDir, "R-meta", "meta test");
const base = await ledger.addFinding(
  hordeDir,
  "R-meta",
  "member-1",
  "vendor X exposes endpoint /api/v1/check with header X-API-Key",
  { ideaId: 1, importance: "high", confidence: "high" },
);
const sameAgain = await ledger.addFinding(
  hordeDir,
  "R-meta",
  "member-2",
  "vendor X exposes endpoint /api/v1/check with header X-API-Key",
);
assert.equal(sameAgain.duplicateOf?.id, base.finding.id);
const parsedMeta = ledger.parseFindings(fs.readFileSync(path.join(hordeDir, "FINDINGS.md"), "utf-8"));
assert.deepEqual(parsedMeta.find((e) => e.id === base.finding.id).corroborators, ["member-2"]);
const metaClusters = ledger.clusterFindings(parsedMeta.filter((e) => e.runId === "R-meta"));
assert.ok(
  metaClusters.some((c) => c.members.includes("member-1") && c.members.includes("member-2")),
  "corroborating members must survive clustering",
);
const delta = await ledger.addFinding(
  hordeDir,
  "R-meta",
  "member-3",
  "vendor X also leaks a second endpoint /api/v2/decision",
  { deltaOf: base.finding.id, importance: "medium", confidence: "medium" },
);
assert.equal(delta.finding.deltaOf, base.finding.id);
const superseding = await ledger.addFinding(
  hordeDir,
  "R-meta",
  "member-4",
  "vendor Y endpoint /api/v1/verify returns 403",
  { supersedes: delta.finding.id },
);
assert.equal(superseding.finding.supersedes, delta.finding.id);
const metaSummaries = ledger.findingSummaries(hordeDir, "R-meta");
assert.match(metaSummaries, /delta of F/);
assert.match(metaSummaries, /supersedes F/);
assert.match(metaSummaries, /\+member-2/);
const parsedAfterSupersede = ledger.parseFindings(
  fs.readFileSync(path.join(hordeDir, "FINDINGS.md"), "utf-8"),
);
assert.equal(
  parsedAfterSupersede.find((e) => e.id === delta.finding.id).supersededBy,
  superseding.finding.id,
);
const foldedClusters = ledger.clusterFindings(
  parsedAfterSupersede.filter((e) => e.runId === "R-meta"),
);
const baseCluster = foldedClusters.find((c) => c.findings.some((f) => f.id === base.finding.id));
assert.ok(
  baseCluster.findings.some((f) => f.id === delta.finding.id),
  "a declared delta must fold into its parent cluster",
);

// Facts: leading id stripped, delta path, and delta validation.
const f1 = await ledger.addFact(hordeDir, "member-1", "[T4] endpoint X returns 403 with header X-API-Key");
assert.equal(f1.fact.id, 1);
assert.ok(!f1.fact.text.startsWith("["), "leading [T#] must be stripped from a fact body");
const f1dup = await ledger.addFact(hordeDir, "member-2", "endpoint X returns 403 with header X-API-Key");
assert.equal(f1dup.duplicateOf?.id, 1);
const f1delta = await ledger.addFact(hordeDir, "member-3", "endpoint X also sets X-Request-Id", 1);
assert.equal(f1delta.fact.deltaOf, 1);
await assert.rejects(
  ledger.addFact(hordeDir, "member-3", "delta to a fact that does not exist", 99),
  /does not exist/,
);
const parsedFacts = ledger.parseFacts(fs.readFileSync(path.join(hordeDir, "FACTS.md"), "utf-8"));
assert.equal(parsedFacts.find((f) => f.id === 1).deltaOf, undefined);
assert.equal(parsedFacts.find((f) => f.id === f1delta.fact.id).deltaOf, 1);

// Topic-anchor clustering: a shared URL merges two differently worded findings.
await ledger.appendRunHeading(hordeDir, "R-anchor", "anchor test");
const anchorA = await ledger.addFinding(
  hordeDir,
  "R-anchor",
  "member-1",
  "TrafficGuard redirect lands on https://trafficguard.to/r and returns the real page",
);
const anchorB = await ledger.addFinding(
  hordeDir,
  "R-anchor",
  "member-2",
  "Separate check of https://trafficguard.to/r shows a bot verdict branch",
);
assert.equal(ledger.clusterFindings([anchorA.finding, anchorB.finding]).length, 1);

// Plan seeding bypasses dedup and creates one open idea per layer.
const seeded = await ledger.seedPlan(hordeDir, ["layer one probe", "layer two probe"]);
assert.equal(seeded.length, 2);
assert.ok(ledger.listIdeas(hordeDir).some((i) => i.id === seeded[0].id && i.mark === " "));

// Support level is parsed and stored under the neutral vocabulary.
const evFinding = await ledger.addFinding(hordeDir, "R-meta", "member-5", "observed live 403 at https://example.test/ev", {
  support: "reproduced",
});
assert.equal(
  ledger.parseFindings(fs.readFileSync(path.join(hordeDir, "FINDINGS.md"), "utf-8")).find(
    (e) => e.id === evFinding.finding.id,
  ).support,
  "reproduced",
);

// Legacy findings are stamped once, so ids no longer inflate on every parse.
const stampCwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-stamp-"));
const stampDir = ledger.initHordeDir(stampCwd);
let raw = "# Findings\n\n## Run R-stamp (x): p\n";
for (let i = 0; i < 5; i++) raw += `\n### 00:00:0${i} member-1\nlegacy ${i} stub${i}\n`;
fs.writeFileSync(path.join(stampDir, "FINDINGS.md"), raw);
const stampFirst = await ledger.addFinding(stampDir, "R-stamp", "member-2", "brand new finding gamma delta epsilon");
const stampSecond = await ledger.addFinding(stampDir, "R-stamp", "member-2", "another new finding zeta eta theta");
assert.equal(stampSecond.finding.id, stampFirst.finding.id + 1);
assert.ok(stampFirst.finding.id <= 6, `expected a small id, got ${stampFirst.finding.id}`);
console.log("PASS: horde-board-test");
