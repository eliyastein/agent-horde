// A run that closes work without a `horde solved` proposal still gets a scoreable ANSWER.md:
// answerScaffold names the closed and ruled-out ideas, the finding review status, and the
// blockers open at freeze, and returns undefined only when the run produced nothing.
import assert from "node:assert/strict";
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

const { answerScaffold } = await jiti.import("../src/run/finalize.ts");

const ideas = [
  { id: 1, mark: "x", text: "Passive infra map", owner: "member-3" },
  { id: 2, mark: "x", text: "Static binary pass", owner: "member-1" },
  { id: 3, mark: "!", text: "Duplicate of #1", owner: "member-4", note: "dup of #1" },
  { id: 4, mark: "~", text: "Attribution corpus", owner: "member-2" },
];
const acceptance = {
  status: "incomplete",
  hash: "abc123",
  issues: [
    "Q118 A82: responded blocking challenge",
    "A82@deadbeef: blocked by Q118 (responded blocking challenge from member-2); exclude from recommended document outputs",
    "F1: no independent review of the current revision",
    "F6: independently reviewed with limitations; full claim coverage is not established (see V125)",
  ],
};

// Full scaffold: every section present, with the DELIVERABLE pointer.
const full = answerScaffold("20261121-213757-h2", ideas, 12, acceptance, true);
assert.ok(full, "scaffold is produced when the run closed ideas and filed findings");
assert.match(full, /^# Answer - run 20261121-213757-h2/);
assert.match(full, /No member proposed a solve/);
assert.match(full, /See DELIVERABLE\.md for the reconciled operator output/);
assert.match(full, /acceptance incomplete \(snapshot abc123\)/);
assert.match(full, /12 finding\(s\) filed, 2 idea\(s\) closed, 1 ruled out/);
assert.match(full, /## Ideas closed\n- #1 Passive infra map \(@member-3\)\n- #2 Static binary pass \(@member-1\)/);
assert.match(full, /## Ideas ruled out\n- #3 Duplicate of #1 \(@member-4\) - dup of #1/);
assert.match(full, /## Ideas still open\n- #4 Attribution corpus \(@member-2\)/);
assert.match(full, /## Findings and review status\n- F1: no independent review[\s\S]*- F6: independently reviewed/);
assert.match(full, /## Open blockers at freeze\n- Q118 A82: responded blocking challenge/);
assert.match(full, /## Artifacts excluded from recommended output\n- A82@deadbeef: blocked by Q118/);

// Without a deliverable yet, the pointer is just to ACCEPTANCE.md.
const early = answerScaffold("r", ideas, 12, acceptance, false);
assert.match(early, /it is not a member's claim\. See ACCEPTANCE\.md/);
assert.doesNotMatch(early, /DELIVERABLE\.md/);

// Findings but no review lines: the count stands in.
const noReviews = answerScaffold("r", [], 3, { status: "incomplete", hash: "h", issues: [] }, false);
assert.match(noReviews, /## Findings and review status\n- 3 finding\(s\) filed; see FINDINGS\.md/);
assert.doesNotMatch(noReviews, /## Open blockers at freeze/);
assert.doesNotMatch(noReviews, /## Ideas closed/);

// A run that produced nothing gets no scaffold.
const empty = answerScaffold("r", [{ id: 1, mark: "~", text: "wip", owner: "member-1" }], 0, { status: "complete", hash: "h", issues: [] }, false);
assert.equal(empty, undefined, "no findings and no closed ideas means no scaffold");

console.log("ok");
