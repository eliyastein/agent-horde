import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanStopFor } from "../ledger/run-signals.js";

const WIND_DOWN_ENTRY = "horde-wind-down";

const REASONS: Record<string, string> = {
  "stop-clean": "the user asked the run to stop",
  budget: "the run reached its budget",
  deadline: "the run reached its time limit",
  solved: "a validated answer exists and the run is closing",
};

const WRAP_UP_STEPS =
  "Use only the horde tool now: file what you found and have not recorded yet (finding, fact), " +
  "mark each idea you hold done, rule-out or drop with a note on what remains, then give a " +
  "one-sentence summary and stop.";

function reasonFor(label: string | undefined): string {
  return REASONS[label ?? ""] ?? REASONS["stop-clean"] ?? "";
}

/** The result a member gets in place of a non-horde tool call once the run is winding down. */
export function blockedToolText(toolName: string, label: string | undefined): string {
  return (
    `The run is winding down (${reasonFor(label)}), so this ${toolName} call was not executed and ` +
    `the members are terminated when the grace period ends. ${WRAP_UP_STEPS}`
  );
}

/** The wrap-up message pushed into a member's context at its next turn boundary. */
export function wrapUpText(label: string | undefined): string {
  const partial = label === "solved" ? "" : " Unrecorded work is lost when the member is terminated.";
  return `The run is winding down: ${reasonFor(label)}. Tools other than horde are now refused.${partial} ${WRAP_UP_STEPS}`;
}

interface WindDownContext {
  hordeDir: string;
  runId: string;
  member: string;
}

/**
 * Once a clean stop names the member, refuse every tool but `horde` and insert one wrap-up message
 * at the next turn boundary, so a member in the middle of a bash or read chain records what it has
 * instead of investigating until the hard stop.
 */
export function registerWindDown(pi: ExtensionAPI, ctx: WindDownContext): void {
  if (typeof pi.on !== "function") return;
  let told = false;
  pi.on("tool_call", (event) => {
    if (event.toolName === "horde") return;
    const stop = cleanStopFor(ctx.hordeDir, ctx.runId, ctx.member);
    if (!stop) return;
    return { block: true, reason: blockedToolText(event.toolName, stop.label) };
  });
  const boundary = (event: { outcome: string; context: { canContinue: boolean } }) => {
    if (told || event.outcome !== "completed" || !event.context.canContinue) return;
    const stop = cleanStopFor(ctx.hordeDir, ctx.runId, ctx.member);
    if (!stop) return;
    told = true;
    return {
      continue: true,
      entries: [{ type: "custom_message" as const, customType: WIND_DOWN_ENTRY, display: true, content: wrapUpText(stop.label) }],
    };
  };
  pi.on("turn_end", boundary);
  pi.on("agent_before_settle", boundary);
  pi.on("session_compact", () => { told = false; });
}
