// Tool-action coverage gaps: confirm/retract/supersede claims, rule-out notes,
// clean-stop refusal of assert, and the idle handoff hint.
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
  ...(await jiti.import("../src/ledger/claims.ts")),
  ...(await jiti.import("../src/ledger/files.ts")),
  ...(await jiti.import("../src/ledger/ideas.ts")),
  ...(await jiti.import("../src/ledger/run-signals.ts")),
};

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-actions-"));
const hordeDir = ledger.initHordeDir(cwd);
await ledger.appendRunHeading(hordeDir, "R1", "actions probe");
const run = (params) => actions.runHordeAction(hordeDir, "member-1", params, "R1");

// Ideas: add, claim, rule-out with a reason, and the idle hint on done.
const a = await run({ action: "idea", text: "claim state machine probe" });
assert.equal(a.text, "Added idea #1: claim state machine probe");
await run({ action: "claim", id: 1 });
const ruled = await run({ action: "rule-out", id: 1, text: "dead end: no sink" });
assert.match(ruled.text, /Ruled out #1: dead end: no sink/);
assert.equal(ledger.listIdeas(hordeDir).find((i) => i.id === 1).mark, "!");

// Claims: assert, confirm, contest, retract, supersede.
const c1 = await run({ action: "assert", text: "tokens are not rotated" });
assert.match(c1.text, /Asserted C1: tokens are not rotated/);
const confirmed = await run({ action: "confirm", id: 1, text: "reproduced twice" });
assert.match(confirmed.text, /Confirmed C1 \[confirmed\]/);
const c2 = await run({ action: "assert", text: "tokens are rotated hourly" });
assert.match(c2.text, /Asserted C2/);
const superseded = await run({ action: "supersede", id: 2, text: "C1 the evidence is stronger" });
assert.match(superseded.text, /Superseded C2 \[superseded\]/);
let claims = ledger.listClaims(hordeDir);
assert.equal(claims.find((c) => c.id === 1).state, "confirmed");
const claim2 = claims.find((c) => c.id === 2);
assert.equal(claim2.state, "superseded");
assert.match(claim2.notes.join(" | "), /C1 supersedes it/);

await run({ action: "assert", text: "third hypothesis" });
const retracted = await run({ action: "retract", id: 3, text: "no evidence" });
assert.match(retracted.text, /Retracted C3 \[retracted\]/);
// Missing id is a tool error.
await assert.rejects(run({ action: "confirm" }), /id is required for action 'confirm'/);

// Clean stop refuses assert/idea/claim but allows reads and wrap-up.
const runDir = path.join(hordeDir, "runs", "R1");
fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true });
ledger.writeCleanStop(runDir, { runId: "R1", members: [], at: new Date().toISOString() });
const refusedAssert = await run({ action: "assert", text: "should be refused" });
assert.match(refusedAssert.text, /clean stop was requested/i);
const refusedIdea = await run({ action: "idea", text: "should be refused" });
assert.match(refusedIdea.text, /clean stop was requested/i);
const allowedList = await run({ action: "list" });
assert.match(allowedList.text, /claim state machine probe/);
const allowedPost = await run({ action: "post", text: "wrapping up" });
assert.equal(allowedPost.text, "Posted to BOARD.md");
ledger.clearCleanStop(runDir);

// Idle handoff: finishing the last claimed idea while another is open appends the open list.
const b = await run({ action: "idea", text: "open leftover work item" });
const leftover = await run({ action: "idea", text: "still open target work" });
await run({ action: "claim", id: b.id });
const done = await run({ action: "done", id: b.id, text: "finished" });
assert.match(done.text, /Open ideas:/);
assert.match(done.text, new RegExp(`#${leftover.id}`));

// Findings require claimed ownership and concern metadata; deltas keep the same concern.
await run({ action: "claim", id: leftover.id });
await assert.rejects(
  run({ action: "finding", idea: leftover.id, support: "sourced", text: "missing concern" }),
  /concern is required/,
);
const base = await run({
  action: "finding", idea: leftover.id, concern: "probe-http-authz", concernDef: "probe http authz root cause and entry point", text: "base finding probe\nbody",
  importance: "high", confidence: "high", support: "reproduced",
});
const baseId = base.id;
const delta = await run({
  action: "finding", idea: leftover.id, concern: "probe-http-authz", concernDef: "probe http authz root cause and entry point", text: "delta evidence probe\nmore",
  deltaOf: baseId, importance: "medium", support: "tested",
});
assert.notEqual(delta.id, baseId);
const dup = await run({
  action: "finding", idea: leftover.id, concern: "probe-http-authz", concernDef: "probe http authz root cause and entry point", support: "sourced",
  text: "base finding probe\nbody",
});
assert.match(dup.text, /already records this/);
assert.equal(dup.id, baseId);
await assert.rejects(
  run({
    action: "finding", idea: leftover.id, concern: "artifact-proof", concernDef: "artifact proof root cause and entry point", support: "derived",
    text: "Artifact proof\nrun .horde/runs/R1/artifacts/proof.py",
  }),
  /must cite its registered resource R#/,
);
const resource = await run({
  action: "resource", text: "artifact proof harness", note: ".horde/runs/R1/artifacts/proof.py",
});
const artifactFinding = await run({
  action: "finding", idea: leftover.id, concern: "artifact-proof", concernDef: "artifact proof root cause and entry point", support: "derived",
  text: `Artifact proof\nrun R${resource.id} at .horde/runs/R1/artifacts/proof.py`,
});
assert.match(artifactFinding.text, /Recorded finding F\d+ \[artifact-proof\]/);
const summaries = await run({ action: "findings" });
assert.match(summaries.text, /concern=probe-http-authz/);
assert.match(summaries.text, /delta of F/);

// Fact delta.
const f1 = await run({ action: "fact", text: "endpoint returns 403" });
const f1dup = await run({ action: "fact", text: "endpoint returns 403" });
assert.match(f1dup.text, /already recorded/);
const f1delta = await run({ action: "fact", text: "endpoint also sets X-Request-Id", deltaOf: f1.id });
assert.notEqual(f1delta.id, f1.id);

// Unknown actions and run-scoped actions without a run fail with a clear message.
await assert.rejects(run({ action: "bogus" }), /unknown action 'bogus'/);
delete process.env.PI_HORDE_RUN;
for (const action of ["solved", "confirm-solved", "contest-solved", "verify"]) {
  await assert.rejects(
    actions.runHordeAction(hordeDir, "member-1", { action, id: 1, text: "x" }, undefined),
    new RegExp(`horde: ${action} needs an active run`),
  );
}

fs.rmSync(cwd, { recursive: true, force: true });
console.log("PASS: horde-actions-test");
