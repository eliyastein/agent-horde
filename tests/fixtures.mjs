// Builds a synthetic .horde directory for the dashboard tests, so the suite does
// not depend on a recorded run from a developer machine.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const FIXTURE_RUN = "20260913-010341";
export const FIXTURE_OLDER_RUN = "20260913-010151";
export const FIXTURE_PROMPT = "evaluate the implementation";

function task(id, prompt, count = 3) {
  return [
    `# Horde run ${id}`,
    "",
    "Started: 2026-09-13 01:03:41",
    `Members: ${count} (member-1 .. member-${count})`,
    "Model: deepseek/deepseek-v4-flash",
    "Thinking: medium",
    "",
    "## Prompt",
    "",
    prompt,
    "",
  ].join("\n");
}

function memberLog() {
  return "[horde] spawn: pi --mode json -p\n[horde] exit code 0 status done cause completed\n";
}

/** A 174-entry pi session with a user prompt and `read` tool calls. */
function bigSession() {
  const lines = [
    JSON.stringify({ type: "session", id: "fixture-session", cwd: "/fixture", timestamp: "2026-09-13T05:03:42.004Z" }),
    JSON.stringify({ type: "model_change", provider: "deepseek", modelId: "deepseek-v4-flash", timestamp: "2026-09-13T05:03:42.010Z" }),
    JSON.stringify({ type: "message", timestamp: "2026-09-13T05:03:42.020Z", message: { role: "user", content: FIXTURE_PROMPT } }),
  ];
  let turn = 0;
  while (lines.length < 174) {
    turn++;
    const stamp = `2026-09-13T05:0${3 + (turn % 6)}:${String(turn % 60).padStart(2, "0")}.000Z`;
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: stamp,
        message: {
          role: "assistant",
          model: "deepseek/deepseek-v4-flash",
          stopReason: "stop",
          usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total: 0.001 } },
          content: [
            { type: "text", text: "working on it" },
            { type: "toolCall", id: `t${turn}`, name: "read", arguments: { path: "/fixture/file.txt" } },
          ],
        },
      }),
    );
    if (lines.length < 174) {
      lines.push(
        JSON.stringify({
          type: "message",
          timestamp: stamp,
          message: { role: "toolResult", toolName: "read", toolCallId: `t${turn}`, content: [{ type: "text", text: "file body" }], isError: false },
        }),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function smallSession() {
  return [
    JSON.stringify({ type: "session", id: "small", cwd: "/fixture", timestamp: "2026-09-13T05:01:51.000Z" }),
    JSON.stringify({ type: "message", timestamp: "2026-09-13T05:01:52.000Z", message: { role: "user", content: "hello" } }),
    "",
  ].join("\n");
}

/** Write the fixture into a fresh temp directory and return the horde dir. */
export function buildHordeFixture() {
  const horde = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "horde-fixture-")), ".horde");
  const runDir = path.join(horde, "runs", FIXTURE_RUN);
  const olderDir = path.join(horde, "runs", FIXTURE_OLDER_RUN);
  fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true });
  fs.mkdirSync(olderDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, "TASK.md"), task(FIXTURE_RUN, FIXTURE_PROMPT));
  fs.writeFileSync(path.join(runDir, "SUMMARY.md"), "# Horde run\n\n## member-1: done\n\nsummary text\n");
  for (const member of ["member-1", "member-2", "member-3"]) {
    fs.writeFileSync(path.join(runDir, `${member}.log`), memberLog());
  }
  fs.writeFileSync(path.join(runDir, "sessions", "2026-09-13T05-03-42-004Z_aaaaaaaa.jsonl"), bigSession());
  fs.writeFileSync(path.join(runDir, "sessions", "2026-09-13T05-03-42-024Z_bbbbbbbb.jsonl"), smallSession());
  fs.writeFileSync(path.join(runDir, "sessions", "2026-09-13T05-03-42-044Z_cccccccc.jsonl"), smallSession());
  fs.writeFileSync(path.join(olderDir, "TASK.md"), task(FIXTURE_OLDER_RUN, "first prompt"));

  fs.writeFileSync(
    path.join(horde, "BOARD.md"),
    [
      "# Board",
      "",
      `## Run ${FIXTURE_OLDER_RUN} (2026-09-13 01:01:51): first prompt`,
      "",
      "### 01:01:55 member-2",
      "older post",
      "",
      `## Run ${FIXTURE_RUN} (2026-09-13 01:03:41): ${FIXTURE_PROMPT}`,
      "",
      "### 01:03:50 member-1",
      "planning",
      "",
      "### 01:03:55 member-2",
      "finished the work",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(horde, "FINDINGS.md"),
    [
      "# Findings",
      "",
      `## Run ${FIXTURE_RUN} (2026-09-13 01:03:41): ${FIXTURE_PROMPT}`,
      "",
      "### 01:03:50 member-1 [F1] sev=high conf=high ev=source-verified",
      "the fixture finding body",
      "fixture detail line shown only when expanded",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(horde, "IDEAS.md"),
    [
      "# Ideas",
      "",
      "- [ ] #1 open item",
      "- [~] #2 in progress  @member-2",
      "- [x] #3 done item  @member-1",
      "- [!] #4 dead end  @member-2: ruled out",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(horde, "FACTS.md"), "# Facts\n");
  fs.writeFileSync(path.join(horde, "CLAIMS.md"), "# Claims\n");
  fs.writeFileSync(
    path.join(horde, "CONCERNS.md"),
    "# Concerns\n\n- fixture-authz: fixture root cause on the fixture entry point  @member-1\n",
  );
  return horde;
}
