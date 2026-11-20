// --context-cap on the member side: at session start the member switches to a copy of its model
// that advertises a context window of cap + reserveTokens, so pi's own threshold compaction fires
// once the context passes the cap. The thinking level from the command line survives the switch.
import assert from "node:assert/strict";
import { createJiti, DEPS, PI } from "./harness.mjs";

delete process.env.PI_HORDE_RUN;
delete process.env.PI_HORDE_CONTEXT_CAP;

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": PI,
    "@earendil-works/pi-ai": `${DEPS}/@earendil-works/pi-ai`,
    "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui`,
    typebox: `${DEPS}/typebox/build/index.mjs`,
  },
});
const { cappedModel, registerContextCap } = await jiti.import("../src/tool/context-cap.ts");
const { registerMemberTool } = await jiti.import("../src/tool/register.ts");

const model = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  compat: { supportsDeveloperRole: false },
  thinkingLevelMap: { high: "high" },
  promptCache: { retention: "long" },
};
const budget = (reserveTokens = 16_384, keepRecentTokens = 20_000, enabled = true) =>
  ({ enabled, reserveTokens, keepRecentTokens });

// ---- the pure core --------------------------------------------------------------------------
const capped = cappedModel(model, 100_000, budget());
assert.equal(capped.model.contextWindow, 116_384, "cap + reserveTokens");
assert.deepEqual({ ...capped.model, contextWindow: model.contextWindow }, model, "every other field is kept");
assert.equal(model.contextWindow, 1_000_000, "the original model is not mutated");
assert.equal(cappedModel(model, 100_000, budget(30_000)).model.contextWindow, 130_000);

const skipFor = (cap, b = budget(), from = model) => cappedModel(from, cap, b).skip;
assert.match(skipFor(36_383), /below 36384 tokens/, "floor: reserveTokens + keepRecentTokens");
assert.equal(cappedModel(model, 36_384, budget()).model.contextWindow, 52_768, "a cap at the floor applies");
assert.match(skipFor(70_000, budget(16_384, 60_000)), /keepRecentTokens 60000/);
assert.match(skipFor(90_000, budget(), { ...model, contextWindow: 100_000 }), /already compacts/);
assert.match(skipFor(100_000, budget(16_384, 20_000, false)), /compaction is disabled/);
console.log("PASS: horde-context-cap-test core");

// ---- registration ---------------------------------------------------------------------------
function fakePi({ settings = {}, authed = true } = {}) {
  const handlers = new Map();
  const pi = {
    handlers,
    models: [],
    thinking: "high",
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
    registerTool: () => {},
    getSettings: () => settings,
    getThinkingLevel: () => pi.thinking,
    setThinkingLevel: (level) => { pi.thinking = level; },
    setModel: async (next) => {
      if (!authed) return false;
      pi.models.push(next);
      pi.thinking = "low";
      return true;
    },
  };
  return pi;
}

const warnings = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (String(chunk).startsWith("agent-horde:")) { warnings.push(String(chunk)); return true; }
  return realWrite(chunk, ...rest);
};
const start = async (pi, ctx = { model }) => {
  const event = { type: "session_start", reason: "startup" };
  for (const handler of pi.handlers.get("session_start") ?? []) await handler(event, ctx);
};

const pi = fakePi();
registerContextCap(pi, 100_000);
assert.deepEqual([...pi.handlers.keys()], ["session_start"], "only session_start is hooked");
await start(pi);
assert.equal(pi.models.length, 1, "setModel is called exactly once");
assert.equal(pi.models[0].contextWindow, 116_384, "pi's default reserveTokens applies");
assert.equal(pi.models[0].maxTokens, 384_000, "pi clamps output per request; maxTokens is kept");
assert.equal(pi.thinking, "high", "the command-line thinking level is restored after the switch");
assert.deepEqual(pi.handlers.get("session_start"), [], "the handler unhooks after deciding");
await start(pi, { model });
assert.equal(pi.models.length, 1, "a later session start does not switch again");
assert.deepEqual(warnings, []);

// pi's settings are read through its own resolver: the per-model override wins over the setting.
const overridden = fakePi({ settings: { compaction: {
  reserveTokens: 30_000,
  modelOverrides: { "deepseek/deepseek-v4-flash": { reserveTokens: 50_000 }, "other/model": { reserveTokens: 1 } },
} } });
registerContextCap(overridden, 100_000);
await start(overridden);
assert.equal(overridden.models[0].contextWindow, 150_000, "cap + the model's reserveTokens override");

const disabled = fakePi({ settings: { compaction: { enabled: false } } });
registerContextCap(disabled, 100_000);
await start(disabled);
assert.equal(disabled.models.length, 0);
assert.match(warnings.pop(), /^agent-horde: --context-cap not applied: compaction is disabled/);

const low = fakePi();
registerContextCap(low, 1_000);
await start(low);
assert.equal(low.models.length, 0, "a cap below the floor does not switch the model");
assert.match(warnings.pop(), /context cap 1000 is below 36384/);

const noAuth = fakePi({ authed: false });
registerContextCap(noAuth, 100_000);
await start(noAuth);
assert.equal(noAuth.thinking, "high");
assert.match(warnings.pop(), /no API key for deepseek\/deepseek-v4-flash/);

const noModel = fakePi();
registerContextCap(noModel, 100_000);
await start(noModel, { model: undefined });
assert.equal(noModel.models.length, 0);
assert.match(warnings.pop(), /the session has no model/);
assert.deepEqual(warnings, []);
console.log("PASS: horde-context-cap-test registration");

// ---- wiring from the member tool and PI_HORDE_CONTEXT_CAP --------------------------------------
process.env.PI_HORDE_DIR = "/nonexistent/.horde";
process.env.PI_HORDE_NAME = "member-1";
process.env.PI_HORDE_CONTEXT_CAP = "";
const uncapped = fakePi();
registerMemberTool(uncapped);
assert.equal(uncapped.handlers.size, 0, "no cap registers nothing");
process.env.PI_HORDE_CONTEXT_CAP = "200000";
const member = fakePi();
registerMemberTool(member);
await start(member);
assert.equal(member.models.length, 1);
assert.equal(member.models[0].contextWindow, 216_384);
process.stderr.write = realWrite;
console.log("PASS: horde-context-cap-test member wiring");
