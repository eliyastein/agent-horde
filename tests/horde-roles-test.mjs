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
const { default: extension } = await jiti.import("../src/index.ts");
const { runHordeAction } = await jiti.import("../src/tool/actions.ts");
const ledger = await jiti.import("../src/ledger/files.ts");

function fakePi() {
  const pi = { commands: {}, tools: {}, events: {}, renderers: {} };
  pi.registerCommand = (name, opts) => { pi.commands[name] = opts; };
  pi.registerTool = (tool) => { pi.tools[tool.name] = tool; };
  pi.registerMessageRenderer = (type, fn) => { pi.renderers[type] = fn; };
  pi.on = (event, fn) => { pi.events[event] = fn; };
  pi.sendMessage = () => {};
  return pi;
}

delete process.env.PI_HORDE_MEMBER;
delete process.env.PI_HORDE_DIR;
delete process.env.PI_HORDE_NAME;
const parent = fakePi();
extension(parent);
assert.deepEqual(Object.keys(parent.commands), ["agent-horde"]);
assert.deepEqual(Object.keys(parent.tools), []);
assert.deepEqual(Object.keys(parent.renderers).sort(), ["agent-horde-report", "agent-horde-swarm-report"]);
assert.ok(parent.events.session_shutdown);

process.env.PI_HORDE_MEMBER = "1";
assert.throws(() => extension(fakePi()), /PI_HORDE_DIR and PI_HORDE_NAME must be set/);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "horde-roles-"));
const hordeDir = ledger.initHordeDir(cwd);
process.env.PI_HORDE_DIR = hordeDir;
process.env.PI_HORDE_NAME = "member-2";
const child = fakePi();
extension(child);
assert.deepEqual(Object.keys(child.commands), []);
assert.deepEqual(Object.keys(child.tools), ["horde"]);
assert.equal(child.events.session_shutdown, undefined);
const tool = child.tools.horde;
const run = (params) => tool.execute("call", params, undefined, undefined, {});

let r = await run({ action: "idea", text: "look at auth" });
assert.equal(r.content[0].text, "Added idea #1: look at auth");
assert.deepEqual(r.details, { action: "idea", id: 1 });
r = await run({ action: "list" });
assert.equal(r.content[0].text, "#1 [ ] look at auth");
const dupIdea = await run({ action: "idea", text: "look at auth flows" });
assert.match(dupIdea.content[0].text, /already exists as #1/);
assert.equal(dupIdea.details.id, 1);
const claim = await run({ action: "assert", text: "ACCEPT mode is inverted" });
assert.equal(claim.details.id, 1);
const contested = await run({ action: "contest", id: 1, text: "primary source disagrees" });
assert.match(contested.content[0].text, /Contested C1 \[contested\]/);
const claims = await run({ action: "claims" });
assert.match(claims.content[0].text, /C1 \[contested\]/);
const fact = await run({ action: "fact", text: "dig cloaktrack-api.online has no A record" });
assert.match(fact.content[0].text, /Recorded fact T1/);
const facts = await run({ action: "facts" });
assert.match(facts.content[0].text, /T1 dig cloaktrack-api\.online/);
const unownedPlan = await run({ action: "post", text: "plan: review the auth flow" });
assert.match(unownedPlan.content[0].text, /Claim a non-overlapping idea/);
r = await run({ action: "claim", id: 1 });
assert.equal(r.content[0].text, "Claimed #1: look at auth");
r = await run({ action: "post", text: "starting on auth" });
assert.equal(r.content[0].text, "Posted to BOARD.md");
r = await run({ action: "finding", idea: 1, concern: "auth-login", concernDef: "auth login root cause and entry point", support: "sourced", text: "Title\nevidence path" });
assert.match(r.content[0].text, /Recorded finding F\d+ \[auth-login\]: Title/);
const dupFinding = await run({ action: "finding", idea: 1, concern: "auth-login", concernDef: "auth login root cause and entry point", support: "sourced", text: "Title\nevidence path extra" });
assert.match(dupFinding.content[0].text, /already records this/);
r = await run({ action: "done", id: 1, text: "nothing found" });
assert.equal(r.content[0].text, "Done #1: look at auth");
await assert.rejects(run({ action: "claim" }), /id is required for action 'claim'/);
await assert.rejects(run({ action: "claim", id: 42 }), /idea #42 does not exist/);
await assert.rejects(run({ action: "post" }), /text is required for action 'post'/);
await assert.rejects(runHordeAction(hordeDir, "member-5", { action: "claim", id: 1 }), /already done/);
await run({ action: "idea", text: "second" });
await runHordeAction(hordeDir, "member-5", { action: "claim", id: 2 });
await assert.rejects(run({ action: "claim", id: 2 }), /already claimed by member-5/);
await assert.rejects(run({ action: "drop", id: 2 }), /claimed by member-5/);
r = await runHordeAction(hordeDir, "member-5", { action: "drop", id: 2, text: "boring" });
assert.match(r.text, /^Dropped #2: second/);

// Idle handoff: finishing the last owned idea surfaces open work.
await run({ action: "idea", text: "idle hint target" });
const owned = await run({ action: "idea", text: "idle hint owned" });
await run({ action: "claim", id: owned.details.id });
const finished = await run({ action: "done", id: owned.details.id, text: "done" });
assert.match(finished.content[0].text, /Open ideas:/);
assert.match(finished.content[0].text, /#\d+ idle hint target/);

const ideas = fs.readFileSync(path.join(hordeDir, "IDEAS.md"), "utf-8");
assert.ok(ideas.includes("- [x] #1 look at auth  @member-2: nothing found"));
assert.ok(ideas.includes("- [ ] #2 second\n"));
console.log("PASS: horde-roles-test");
