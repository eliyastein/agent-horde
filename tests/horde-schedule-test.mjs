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
const { addFinding } = await jiti.import("../src/ledger/findings.ts");
const { collaborationState } = await jiti.import("../src/ledger/collaboration.ts");
const { runCollaborationAction } = await jiti.import("../src/tool/collaboration-actions.ts");
const { loadCollaborationReport } = await jiti.import("../src/collaboration-report.ts");
const { scheduleCollaboration } = await jiti.import("../src/run/schedule.ts");
const { newMemberState } = await jiti.import("../src/member.ts");

fs.mkdirSync(".tmp", { recursive: true });
const cwd = fs.mkdtempSync(path.resolve(".tmp/horde-schedule-"));
const hordeDir = initHordeDir(cwd);

async function fixtureRun(id, statuses) {
  const runDir = path.join(hordeDir, "runs", id);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  await appendRunHeading(hordeDir, id, "schedule fixture");
  const members = statuses.map((status, i) => Object.assign(newMemberState(i + 1), { status }));
  const run = { id, runDir, hordeDir, members, verifier: `member-${members.length}`, stopped: false, controller: new AbortController() };
  return { run, state: { disposed: false } };
}

async function publish(launch, name, extra = {}) {
  const { run } = launch;
  fs.writeFileSync(path.join(run.runDir, "artifacts", name), `${name} body\n`);
  const result = await runCollaborationAction({ hordeDir, runId: run.id, actor: "member-1" },
    { action: "artifact", artifactPath: `artifacts/${name}`, artifactKind: "document", criteria: "accurate", ...extra });
  return JSON.parse(result.text).artifact;
}

const messagesTo = (launch, kind) => collaborationState(hordeDir, launch.run.id).messages.filter((m) => m.kind === kind && m.sender === "parent");

// A superseded dependency is named with its successor, and the owner is asked to republish.
{
  const launch = await fixtureRun("20261005-230001", ["done", "done", "done"]);
  const id = launch.run.id;
  const original = (await addFinding(hordeDir, id, "member-2", "Edge record links vendor to host at dns/a.txt", { concern: "edge", concernDef: "vendor edge", concernNew: true })).finding;
  const dependent = await publish(launch, "edge.md", { dependsOn: [`F${original.id}`] });
  const corrected = (await addFinding(hordeDir, id, "member-2", "Edge record links vendor to load balancer at dns/b.txt", { concern: "edge", supersedes: original.id })).finding;
  const issue = loadCollaborationReport(hordeDir, id).issues.find((i) => i.startsWith(dependent.id));
  assert.match(issue, new RegExp(`dependency F${original.id} superseded by F${corrected.id}; republish against F${corrected.id}`));
  assert.doesNotMatch(issue, /dependency unavailable/);

  await scheduleCollaboration(launch, { settleMs: 0, liveOnly: false });
  await scheduleCollaboration(launch, { settleMs: 0, liveOnly: false });
  const handoffs = messagesTo(launch, "handoff");
  assert.equal(handoffs.length, 1, "one repin handoff per artifact revision");
  assert.equal(handoffs[0].to, "member-1");
  assert.equal(handoffs[0].target, dependent.id);
  assert.match(handoffs[0].text, new RegExp(`F${original.id} -> F${corrected.id}`));
  assert.equal(messagesTo(launch, "review-request").length, 1, "review assignment is idempotent too");
}

// Reviews go to the least-loaded non-owner; the verifier wins ties.
{
  const launch = await fixtureRun("20261005-230002", ["done", "done", "done"]);
  for (const name of ["a.md", "b.md", "c.md"]) await publish(launch, name);
  await scheduleCollaboration(launch, { settleMs: 0, liveOnly: false });
  assert.deepEqual(messagesTo(launch, "review-request").map((m) => m.to), ["member-3", "member-2", "member-3"]);
}

// During discovery a fresh revision waits, and only running members are assigned.
{
  const launch = await fixtureRun("20261005-230003", ["running", "running", "done"]);
  await publish(launch, "fresh.md");
  await scheduleCollaboration(launch, { settleMs: 60_000, liveOnly: true });
  assert.equal(messagesTo(launch, "review-request").length, 0, "a revision under active edit is not assigned");
  await scheduleCollaboration(launch, { settleMs: 0, liveOnly: true });
  assert.deepEqual(messagesTo(launch, "review-request").map((m) => m.to), ["member-2"], "the finished verifier cannot see a new inbox item");
}

console.log(`PASS: horde-schedule-test (fixtures retained in ${cwd})`);
