import * as fs from "node:fs";
import * as path from "node:path";
import { pendingReviewsForMember } from "./ledger/findings.js";
import { listIdeas } from "./ledger/ideas.js";
import { oneLine } from "./format.js";
import { parseTaskMarkdown } from "./prompt.js";

/**
 * Decides when a member gets its goal restated: every `calls` horde-tool calls
 * or every `ms` milliseconds, whichever comes first. Zero disables that trigger;
 * both zero means never. One instance lives per member process.
 */
export class ReminderGate {
  private count = 0;
  private last: number;

  constructor(
    private readonly calls: number,
    private readonly ms: number,
    now: number = Date.now(),
  ) {
    this.last = now;
  }

  /** Count one tool call; true when a reminder is due (and the counters restart). */
  tick(now: number = Date.now()): boolean {
    this.count += 1;
    const byCalls = this.calls > 0 && this.count >= this.calls;
    const byTime = this.ms > 0 && now - this.last >= this.ms;
    if (!byCalls && !byTime) return false;
    this.count = 0;
    this.last = now;
    return true;
  }
}

/**
 * A short restatement of the task, the member's role, and its claimed work.
 * Appended to a tool result so a long-running session cannot drift away from
 * the goal it was given. Returns "" when the run files cannot be read.
 */
export function goalReminder(
  hordeDir: string,
  runId: string,
  member: string,
  role: string | undefined,
): string {
  try {
    const taskFile = path.join(hordeDir, "runs", runId, "TASK.md");
    const task = parseTaskMarkdown(fs.readFileSync(taskFile, "utf-8"));
    const claimed = listIdeas(hordeDir).filter(
      (idea) => idea.mark === "~" && idea.owner === member,
    );
    const claimedText =
      claimed.length > 0
        ? claimed.map((idea) => `#${idea.id} ${oneLine(idea.text, 120)}`).join("; ")
        : "none";
    const isVerifier = /verifier/i.test(role ?? "");
    const pending = isVerifier
      ? pendingReviewsForMember(hordeDir, runId, member)
      : [];
    const pendingText =
      pending.length > 0
        ? pending.map((finding) => `F${finding.id} ${oneLine(finding.title, 100)}`).join("; ")
        : "none";
    return [
      "",
      `--- goal reminder (run ${runId}) ---`,
      `Task: ${oneLine(task.prompt, 300)}`,
      `You are ${member}. ${role?.trim() || "No assigned role."}`,
      `Claimed: ${claimedText}`,
      ...(isVerifier ? [`Pending verification: ${pendingText}`] : []),
      "If you have not claimed work or recorded evidence since the last reminder, do so or stop.",
    ].join("\n");
  } catch {
    return "";
  }
}
