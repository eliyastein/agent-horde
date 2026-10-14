import assert from "node:assert/strict";
import { createJiti } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const member = await jiti.import("../src/member.ts");
const prompt = await jiti.import("../src/prompt.ts");

const m = member.newMemberState(3);
assert.equal(m.name, "member-3");
assert.equal(m.status, "starting");

const events = [
  { type: "session", version: 3, id: "x" },
  { type: "agent_start" },
  { type: "message_start", message: { role: "assistant", content: [] } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Let me look " } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "at auth." } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Let me look at auth." }], usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total: 0.001 }, totalTokens: 125 }, stopReason: "toolUse" } },
  { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "grep -rn jwt src" } },
];
for (const e of events) member.applyEvent(m, e);
assert.equal(m.status, "running");
assert.equal(m.turns, 1);
assert.equal(m.toolCalls, 1);
assert.equal(m.currentTool, "bash");
assert.equal(m.currentArg, "grep -rn jwt src");
assert.equal(m.lastText, "Let me look at auth.");
assert.equal(m.finalText, "Let me look at auth.");
assert.deepEqual(m.usage, { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.001 });

member.applyEvent(m, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
assert.equal(m.currentTool, undefined);
member.applyEvent(m, { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "ignored" }] } });
assert.equal(m.turns, 1);
member.applyEvent(m, { type: "tool_execution_start", toolCallId: "t2", toolName: "horde", args: { action: "claim", id: 4 } });
assert.equal(m.currentArg, "claim #4");
member.applyEvent(m, { type: "tool_execution_start", toolCallId: "t3", toolName: "grep", args: { pattern: "eval", path: "src" } });
assert.equal(m.currentArg, "eval in src");
member.applyEvent(m, { type: "tool_execution_start", toolCallId: "t4", toolName: "read", args: { path: "/a/b.ts" } });
assert.equal(m.currentArg, "/a/b.ts");
member.applyEvent(m, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Final summary." }], usage: { input: 50, output: 10, cost: { total: 0.002 } }, stopReason: "stop" } });
assert.equal(m.turns, 2);
assert.equal(m.usage.input, 150);
assert.equal(m.usage.cost, 0.003);
assert.equal(m.finalText, "Final summary.");
assert.equal(m.error, undefined);
member.applyEvent(m, { type: "message_start", message: { role: "assistant", content: [] } });
assert.equal(m.lastText, "", "a new assistant message must not inherit the previous tail");
member.applyEvent(m, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial final conclusion" } });
assert.equal(m.draftText, "Partial final conclusion", "streaming text is retained until message_end");
const interruptedSummary = prompt.summaryMarkdown({
  id: "R-partial", prompt: "p", count: 1,
  members: [{ ...m, status: "stopped", finalText: "Earlier completed turn", summaryIncomplete: true }],
  startedAt: Date.now() - 1000, stopped: true,
});
assert.match(interruptedSummary, /\(partial final message\)[\s\S]*Partial final conclusion/);
assert.ok(!interruptedSummary.includes("Earlier completed turn"), "the interrupted draft wins over a stale completed turn");
member.applyEvent(m, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" } });
assert.equal(m.error, "rate limited");
assert.equal(m.finalText, "Final summary.");

let rest = member.splitNdjson('{"a":1}\n{"b":2}\n{"c"', (line) => assert.ok(line.startsWith("{")));
assert.equal(rest, '{"c"');
rest = member.splitNdjson(rest + ':3}\n', (line) => assert.equal(line, '{"c":3}'));
assert.equal(rest, "");

const base = {
  member: m,
  run: { id: "R1", hordeDir: "/p/.horde", runDir: "/p/.horde/runs/R1", prompt: "do things", count: 2 },
  cwd: "/p",
  approve: false,
  signal: new AbortController().signal,
  onChange: () => {},
};
const args = member.buildMemberArgs(base);
assert.deepEqual(args.slice(0, 3), ["--mode", "json", "-p"]);
assert.ok(args.includes("--session-dir"));
assert.equal(args[args.indexOf("--session-dir") + 1], "/p/.horde/runs/R1/sessions/member-3");
assert.equal(member.memberSessionDir("/p/.horde/runs/R1", "member-3"), "/p/.horde/runs/R1/sessions/member-3");
assert.equal(args.filter((a) => a === "--append-system-prompt").length, 2);
assert.ok(args.includes("/p/.horde/runs/R1/SYSTEM.md"));
assert.ok(args.includes("You are member-3."));
assert.ok(!args.includes("--model"));
assert.ok(!args.includes("--approve"));
assert.equal(args[args.length - 2], "--");
assert.equal(args[args.length - 1], "do things");
const args2 = member.buildMemberArgs({ ...base, approve: true, model: { provider: "deepseek", id: "deepseek-chat" }, thinkingLevel: "high" });
assert.ok(args2.includes("--approve"));
assert.equal(args2[args2.indexOf("--model") + 1], "deepseek/deepseek-chat");
assert.equal(args2[args2.indexOf("--thinking") + 1], "high");
assert.equal(args2[args2.length - 1], "do things");
const argsRole = member.buildMemberArgs({ ...base, role: "You own layer 1." });
assert.ok(argsRole.includes("You are member-3. You own layer 1."));
const env = member.memberEnv(base);
assert.equal(env.PI_HORDE_MEMBER, "1");
assert.equal(env.PI_HORDE_DIR, "/p/.horde");
assert.equal(env.PI_HORDE_NAME, "member-3");
assert.equal(env.PI_HORDE_RUN, "R1");

// parseMemberLog reads back the lifecycle lines spawnMember writes.
const doneLog = [
  '[horde] spawn: node ["pi","--mode","json"]',
  "some stderr noise",
  "[horde] exit code 0 status done cause completed",
  "[horde] turns 69 toolCalls 111",
  "[horde] final: Evaluation complete. Verdict follows.",
  "",
].join("\n");
assert.deepEqual(member.parseMemberLog(doneLog), {
  partial: false, spawnErrors: [], resets: [], exitCode: 0, status: "done", endCause: "completed",
  turns: 69, toolCalls: 111, final: "Evaluation complete. Verdict follows.",
});
const killedLog = "[horde] exit code 143 status stopped cause killed partial\n[horde] turns 3 toolCalls 4\n";
const killed = member.parseMemberLog(killedLog);
assert.equal(killed.status, "stopped");
assert.equal(killed.endCause, "killed");
assert.equal(killed.partial, true);
assert.equal(killed.final, undefined);
assert.deepEqual(member.parseMemberLog(""), { partial: false, spawnErrors: [], resets: [] });
const resetLog = member.parseMemberLog("[horde] reset 1: exit_nonzero\n[horde] spawn: pi\n[horde] reset 2: stalled: no ledger write for 30m\n");
assert.deepEqual(resetLog.resets, ["exit_nonzero", "stalled: no ledger write for 30m"]);
const legacy = member.parseMemberLog("[horde] exit code 0 status done\n");
assert.equal(legacy.status, "done");
assert.equal(legacy.endCause, undefined);
const errLog = member.parseMemberLog("[horde] spawn error: ENOENT\nnoise\n");
assert.deepEqual(errLog.spawnErrors, ["[horde] spawn error: ENOENT"]);
console.log("PASS: horde-events-test");
