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
const { initHordeDir } = await jiti.import("../src/ledger/files.ts");
const { appendRunHeading } = await jiti.import("../src/ledger/board.ts");
const ideas = await jiti.import("../src/ledger/ideas.ts");
const findings = await jiti.import("../src/ledger/findings.ts");
const { runCollaborationAction } = await jiti.import("../src/tool/collaboration-actions.ts");
const { collaborationState } = await jiti.import("../src/ledger/collaboration.ts");
const { registerInbox } = await jiti.import("../src/tool/inbox.ts");
const { freezeAcceptance } = await jiti.import("../src/collaboration-report.ts");
const html = await jiti.import("../src/dashboard-html.ts");
const { routeRequest } = await jiti.import("../src/dashboard.ts");
fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-review-thread-regression-"));
const hordeDir = initHordeDir(cwd);
const runId = "20260927-211853";
const runDir = path.join(hordeDir, "runs", runId);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, "TASK.md"), "Members: 3\n");
await appendRunHeading(hordeDir, runId, "review thread regressions");
const ctx = (actor) => ({ hordeDir, runId, actor, attempt: "fixture" });
const command = async (actor, params) => JSON.parse((await runCollaborationAction(ctx(actor), params)).text);
const inspect = (target) => command("member-2", { action: "inspect", target });
const idea = (await ideas.addIdea(hordeDir, "member-1", "check documented session ownership boundary")).idea;
await ideas.claimIdea(hordeDir, "member-1", idea.id);
const f = (await findings.addFinding(hordeDir, runId, "member-1", "Original session boundary claim", { ideaId: idea.id, concern: "original-boundary", concernDef: "session ownership boundary" })).finding;
const target = `F${f.id}`;
const original = await inspect(target);
const q = (await command("member-2", { action: "message", target: `I${idea.id}`, kind: "challenge", text: "Check documented application responsibility" })).message;
await command("member-1", { action: "ack", target: q.id, text: "checking" });
await assert.rejects(command("member-1", { action: "respond", target: q.id, revision: original.revision, text: "wrong target hash" }), /respond requires I/);
await command("member-1", { action: "respond", target: q.id, responseTarget: target, revision: original.revision, text: "finding addresses the challenged idea" });
assert.equal((await inspect(q.id)).target, target);
const review = async (subject, unchecked = "") => {
  const info = await inspect(subject);
  const evidence = (await command("member-2", { action: "attach", target: subject, text: "checked local mechanism", relation: "supports" })).evidenceRecord;
  await command("member-2", { action: "review", target: subject, revision: info.revision, verdict: "supports", checked: "scope correction and local mechanism", unchecked, support: "tested", refs: [evidence.id], text: "scope correction accepted" });
  return evidence;
};
const evidence = await review(target, "No full live integration test");
await command("member-2", { action: "resolve", target: q.id, revision: original.revision, refs: [evidence.id], text: "specific objection addressed; limits retained" });
assert.ok(!findings.pendingReviewsForMember(hordeDir, runId, "member-2").some((x) => x.id === f.id), "do not ask the same reviewer to repeat a limited check");
assert.ok(findings.unverifiedFindings(hordeDir, runId).some((x) => x.id === f.id), "limitations still prevent whole-finding acceptance");

// Explicit supersession can correct the concern; a thread follows the successor without copying reviews.
const q2 = (await command("member-2", { action: "message", target, kind: "challenge", text: "wrong sink diagnosis" })).message;
await command("member-1", { action: "ack", target: q2.id, text: "correcting" });
const corrected = (await findings.addFinding(hordeDir, runId, "member-1", "Corrected sink, not external callback delivery", { ideaId: idea.id, concern: "corrected-sink", concernDef: "credential copied to client event stream", supersedes: f.id })).finding;
const next = `F${corrected.id}`;
const revision = (await inspect(next)).revision;
await command("member-1", { action: "respond", target: q2.id, revision, text: "published correction" });
await assert.rejects(command("member-2", { action: "resolve", target: q2.id, refs: [evidence.id], text: "old evidence cannot accept replacement" }), /resolution evidence/);
const replacementEvidence = await review(next, "Live deployment still unchecked");
await command("member-2", { action: "defer", target: q2.id, text: "defer while reviewing" });
await command("member-2", { action: "resolve", target: q2.id, revision, refs: [replacementEvidence.id], text: "correction checked" });
assert.equal(collaborationState(hordeDir, runId).messages.find((m) => m.id === q2.id).state, "resolved");
assert.ok(freezeAcceptance(hordeDir, runId).issues.some((s) => s.startsWith(`${next}:`)), "closing a scope challenge does not hide remaining limitations");

// Delivery bookkeeping and explicit acknowledgement must not produce new model turns.
const q3 = (await command("member-3", { action: "message", target: `I${idea.id}`, text: "status?" })).message;
const handlers = new Map();
registerInbox({ on: (name, fn) => handlers.set(name, fn) }, ctx("member-1"));
const boundary = { outcome: "completed", context: { canContinue: true } };
const insertion = handlers.get("turn_end")(boundary);
assert.ok(insertion);
const entries = insertion.entries.map((e, i) => ({ ...e, id: `entry-${i}` }));
await handlers.get("turn_start")({}, { sessionManager: { getBranch: () => entries } });
assert.equal(handlers.get("turn_end")(boundary), undefined, "pending -> delivered is not new feedback");
await command("member-1", { action: "ack", target: q3.id, text: "working" });
handlers.get("session_compact")();
assert.equal(handlers.get("agent_before_settle")(boundary), undefined, "acknowledged requests do not force redundant turns");

// Shared disclosure renderer: multiple entries, paging/filter/pause state, reload and closing.
const body = html.details("args", html.pre("<untrusted>")) + html.details("thinking", html.pre("reasoning")) + html.details("raw json", html.pre("{value:1}"));
const render = (href) => html.page("fixture", [], body, { href, refresh: { on: true, seconds: 3, toggleHref: "?refresh=0" } });
const decode = (s) => s.replaceAll("&amp;", "&");
const links = (s) => [...s.matchAll(/aria-expanded="(true|false)" href="([^"]+)"/g)].map((m) => ({ open: m[1] === "true", href: decode(m[2]) }));
let page = render("/runs/example/sessions/log?from=100&n=20&refresh=0");
assert.equal(links(page).length, 3);
assert.ok(!page.includes("&lt;untrusted&gt;"));
const opened = links(page)[0].href;
page = render(opened);
assert.ok(page.includes("&lt;untrusted&gt;"));
assert.equal(links(page)[0].open, true);
assert.match(opened, /from=100&n=20&refresh=0/);
const second = links(page)[1].href;
assert.deepEqual(links(render(second)).map((x) => x.open), [true, true, false]);
assert.deepEqual(links(render(second)).map((x) => x.open), [true, true, false], "reload retains both disclosures");
assert.deepEqual(links(render(links(render(second))[0].href)).map((x) => x.open), [false, true, false]);
assert.ok(!page.includes("<details"), "no native transient toggle remains");

const source = { hordeDir, getActive: () => ({ id: runId }) };
const get = (href) => routeRequest(source, "GET", new URL(href, "http://127.0.0.1"), "127.0.0.1");
const first = get(`/runs/${runId}/collaboration?from=0&refresh=0`);
assert.equal(first.status, 200);
const eventLink = links(first.body)[0].href;
assert.match(eventLink, new RegExp(`/runs/${runId}/collaboration`));
assert.equal(links(get(eventLink).body)[0].open, true);
assert.equal(links(get(eventLink).body)[0].open, true, "real route survives refresh");
console.log(`PASS: review thread and dashboard regressions (${cwd})`);
