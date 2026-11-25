// Protocol changes from issue #47:
// A. amend changes a finding's importance, confidence and support, with or without new prose
// B. rule-out records the checks it did not perform, and an answer citing it is told so
// C. a factual correction named in a review opens a blocking request to the owner
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
const board = await jiti.import("../src/ledger/board.ts");
const findings = await jiti.import("../src/ledger/findings.ts");
const ideas = await jiti.import("../src/ledger/ideas.ts");
const collaboration = await jiti.import("../src/ledger/collaboration.ts");
const protocol = await jiti.import("../src/tool/collaboration-actions.ts");
const actions = await jiti.import("../src/tool/actions.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-issue47-protocol-"));
const hordeDir = files.initHordeDir(cwd);
let call = 0;
const command = async (runId, actor, params) =>
  JSON.parse((await protocol.runCollaborationAction({ hordeDir, runId, actor, attempt: "a1", requestId: `call-${++call}` }, params)).text);
const act = (runId, actor, params) => actions.runHordeAction(hordeDir, actor, params, runId, { attempt: "a1", requestId: `act-${++call}` });
const makeRun = async (runId) => {
  const runDir = path.join(hordeDir, "runs", runId);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 4\n");
  await board.appendRunHeading(hordeDir, runId, `issue 47 protocol fixture ${runId}`);
  return runDir;
};
const state = (runId) => collaboration.collaborationState(hordeDir, runId);
const finding = (runId, id) => findings.listFindingsForRun(hordeDir, runId).find((f) => f.id === id);
const heading = (id) => fs.readFileSync(path.join(hordeDir, "FINDINGS.md"), "utf8").split("\n").find((line) => line.includes(`[F${id}]`));
let concernN = 0;
const fileFinding = async (runId, author, text, meta = {}) =>
  (await findings.addFinding(hordeDir, runId, author, text, { concern: `protocol-${++concernN}`, concernDef: `component ${concernN}`, concernNew: true, ...meta })).finding;
const openIdea = async (owner, text) => {
  const { idea } = await ideas.addIdea(hordeDir, owner, text);
  await ideas.claimIdea(hordeDir, owner, idea.id, { checkOverlap: false });
  return idea;
};

// ---- A. amend moves the ranking fields ------------------------------------------------------------
{
  const runId = "20261119-130001";
  await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "The proxy forwards the client certificate header unstripped\nread from the source", { importance: "high", confidence: "medium", support: "tested" });
  const before = findings.findingRevision(finding(runId, f1.id));

  // Ranking only: the prose stays, the heading and the revision move.
  const ranked = await act(runId, "member-1", { action: "amend", id: f1.id, importance: "medium", note: "reviewers showed it needs a non-default flag" });
  assert.match(ranked.text, /ranking changed: importance high -> medium\./);
  assert.equal(ranked.titleChanged, false);
  let current = finding(runId, f1.id);
  assert.equal(current.importance, "medium");
  assert.equal(current.confidence, "medium", "fields the amend does not name are kept");
  assert.equal(current.support, "tested");
  assert.match(heading(f1.id), / imp=medium conf=medium sup=tested /);
  assert.doesNotMatch(heading(f1.id), /imp=high/);
  assert.match(current.body, /^The proxy forwards the client certificate header unstripped\nread from the source\nAmended \d\d:\d\d:\d\d by member-1: reviewers showed it needs a non-default flag \[importance high -> medium\]$/);
  assert.notEqual(findings.findingRevision(current), before, "a ranking change is a new revision for reviewers");
  assert.match(findings.findingSummaries(hordeDir, runId), new RegExp(`F${f1.id} \\[medium/medium/tested\\]`));

  // Prose and ranking together; a field never set is appended to the heading.
  const f2 = await fileFinding(runId, "member-1", "The retry budget is shared across routers\nread from the source", { support: "sourced" });
  const both = await act(runId, "member-1", { action: "amend", id: f2.id, text: "The retry budget is shared across routers\nmeasured with two routers under load", support: "tested", confidence: "high", note: "ran the harness" });
  assert.match(both.text, /ranking changed: confidence unset -> high; support sourced -> tested\./);
  current = finding(runId, f2.id);
  assert.equal(current.support, "tested");
  assert.equal(current.confidence, "high");
  assert.match(current.body, /measured with two routers under load\nAmended .* \[confidence unset -> high; support sourced -> tested\]$/);

  // A legacy heading key is replaced by the current one.
  const findingsPath = path.join(hordeDir, "FINDINGS.md");
  fs.writeFileSync(findingsPath, fs.readFileSync(findingsPath, "utf8").replace(new RegExp(`(\\[F${f2.id}\\][^\\n]*) sup=tested`), "$1 ev=source-reviewed"));
  assert.equal(finding(runId, f2.id).support, "sourced");
  await act(runId, "member-1", { action: "amend", id: f2.id, support: "derived", note: "computed from the config" });
  assert.match(heading(f2.id), / sup=derived/);
  assert.doesNotMatch(heading(f2.id), / ev=/);

  await assert.rejects(act(runId, "member-1", { action: "amend", id: f1.id, importance: "medium", note: "again" }), new RegExp(`F${f1.id} already has that ranking; nothing to amend`));
  await assert.rejects(act(runId, "member-1", { action: "amend", id: f1.id, note: "no change named" }), /amend/);
  await assert.rejects(act(runId, "member-1", { action: "amend", id: f1.id, importance: "medium" }), /amend needs note=/);
  await assert.rejects(act(runId, "member-2", { action: "amend", id: f1.id, importance: "low", note: "not mine" }), /belongs to member-1/);
  await assert.rejects(findings.amendFinding(hordeDir, runId, "member-1", { id: f1.id, text: undefined, note: "n", importance: "severe" }), /amend importance must be one of critical, high, medium, low, info/);
  await assert.rejects(findings.amendFinding(hordeDir, runId, "member-1", { id: f1.id, text: undefined, note: "n", support: "guessed" }), /amend support must be one of/);
}

// ---- B. a rule-out records what it did not check --------------------------------------------------
{
  const runId = "20261119-130002";
  await makeRun(runId);
  const scoped = await openIdea("member-2", "audit the allow-list middleware for client address spoofing");
  await assert.rejects(act(runId, "member-2", { action: "rule-out", id: scoped.id, text: "all three controls are hardened" }), /rule-out needs unchecked: the checks this negative did not perform/);
  const ruled = await act(runId, "member-2", { action: "rule-out", id: scoped.id, text: "client address spoofing is rejected", unchecked: "the verdict computation when deny and allow overlap" });
  assert.match(ruled.text, /Ruled out #\d+: client address spoofing is rejected \| not checked: the verdict computation when deny and allow overlap/);
  const stored = ideas.listIdeas(hordeDir).find((idea) => idea.id === scoped.id);
  assert.equal(stored.mark, "!");
  assert.equal(ideas.ruleOutUnchecked(stored), "the verdict computation when deny and allow overlap");
  assert.match((await act(runId, "member-3", { action: "list" })).text, /not checked: the verdict computation/, "the scope is visible to every member");
  assert.match(fs.readFileSync(path.join(hordeDir, "IDEAS.md"), "utf8"), new RegExp(`- \\[!\\] #${scoped.id} .*  @member-2: client address spoofing is rejected \\| not checked: the verdict computation`), "the idea line still parses with the scope in its note");

  const full = await openIdea("member-3", "check whether the legacy dashboard route is still registered");
  await act(runId, "member-3", { action: "rule-out", id: full.id, text: "the route was removed", unchecked: "" });
  assert.equal(ideas.ruleOutUnchecked(ideas.listIdeas(hordeDir).find((idea) => idea.id === full.id)), undefined, "an empty unchecked declares full coverage");
  assert.equal(ideas.ruleOutUnchecked(ideas.listIdeas(hordeDir).find((idea) => idea.mark !== "!") ?? { mark: " " }), undefined);

  // An answer citing the scoped rule-out is told what it does not cover, at proposal and validation.
  const proposed = await act(runId, "member-1", { action: "solved", text: `No candidate survived: #${scoped.id} and #${full.id} cover the middleware and the dashboard` });
  assert.match(proposed.text, new RegExp(`Note: the answer cites rule-outs that declared unchecked scope: #${scoped.id} \\(not checked: the verdict computation when deny and allow overlap\\)\\.`));
  assert.doesNotMatch(proposed.text, new RegExp(`#${full.id} \\(not checked`));
  const confirmed = await act(runId, "member-4", { action: "confirm-solved", text: "read both" });
  assert.match(confirmed.text, new RegExp(`#${scoped.id} \\(not checked: the verdict computation`));
}

// ---- C. a correction named in a review blocks the owner -------------------------------------------
{
  const runId = "20261119-130003";
  await makeRun(runId);
  const f1 = await fileFinding(runId, "member-1", "The TLS option docs cite the wrong default\ndocs/tls.md:105 says min version 1.0", { support: "sourced" });
  const revision = findings.findingRevision(finding(runId, f1.id));
  const review = { action: "review", target: `F${f1.id}`, revision, verdict: "supports", support: "sourced", checked: "read docs/tls.md", unchecked: "", evidenceText: "the sentence is at docs/tls.md:254", text: "claim holds" };
  const plain = await command(runId, "member-3", review);
  assert.equal(plain.message, undefined, "a supporting review without a correction opens nothing");
  const corrected = await command(runId, "member-2", { ...review, correction: "docs/tls.md:105 should read docs/tls.md:254" });
  assert.equal(corrected.review.correction, "docs/tls.md:105 should read docs/tls.md:254");
  assert.equal(corrected.review.verdict, "supports", "the verdict stands; the correction is a separate obligation");
  const request = corrected.message;
  assert.equal(request.to, "member-1");
  assert.equal(request.sender, "member-2");
  assert.equal(request.blocking, true);
  assert.equal(request.text, `Correction requested in ${corrected.review.id}: docs/tls.md:105 should read docs/tls.md:254`);
  assert.equal(findings.findingReviewState(finding(runId, f1.id), state(runId).reviews, state(runId).messages).status, "disputed", "the open correction keeps the finding from reading as settled");
  assert.ok(collaboration.blockingMessages(state(runId)).some((m) => m.id === request.id));

  // The owner amends; the reviewer carries its review forward without re-raising the correction.
  await act(runId, "member-1", { action: "amend", id: f1.id, text: "The TLS option docs cite the wrong default\ndocs/tls.md:254 says min version 1.0", note: "line number corrected per the review" });
  const next = findings.findingRevision(finding(runId, f1.id));
  await command(runId, "member-1", { action: "respond", target: request.id, revision: next, text: "amended to :254" });
  const carried = await command(runId, "member-2", { action: "reattest", target: `F${f1.id}`, revision: next, evidenceText: "the amended line matches the file", text: "same claim, citation fixed" });
  assert.equal(carried.review.correction, undefined, "a reattested review does not repeat the correction");
  assert.equal(carried.message, undefined);
  await command(runId, "member-2", { action: "resolve", target: request.id, refs: carried.review.evidence, text: "correction applied" });
  assert.equal(collaboration.blockingMessages(state(runId)).length, 0);
  assert.equal(findings.findingReviewState(finding(runId, f1.id), state(runId).reviews, state(runId).messages).status, "full");

  // A refutation already opens a challenge; a correction on it does not open a second thread.
  const f2 = await fileFinding(runId, "member-1", "The HTTP/3 listener ignores the idle timeout\nread from the source", { support: "sourced" });
  const refuted = await command(runId, "member-2", { ...review, target: `F${f2.id}`, revision: findings.findingRevision(finding(runId, f2.id)), verdict: "refutes", evidenceText: "the timeout is applied in the transport", text: "does not hold", correction: "the timeout lives in the transport config" });
  assert.equal(refuted.message.text, "does not hold");
  assert.equal(state(runId).messages.filter((m) => m.target === `F${f2.id}`).length, 1);
}

console.log("issue 47 protocol changes passed");
