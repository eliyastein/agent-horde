import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { terminateAllChildren } from "./member.js";
import { handleHordeCommand, shutdownHorde } from "./run/command.js";
import { controlCompletions } from "./run/completions.js";
import { createHordeState } from "./run/types.js";
import { registerReportRenderer } from "./run/ui.js";
import { registerMemberTool } from "./tool/register.js";
import { startParentWatchdog } from "./watchdog.js";

export default function agentHordeExtension(pi: ExtensionAPI): void {
  // Every pi child a horde spawns (members, post-mortem, deliverable) carries the
  // parent's pid and exits on its own when that parent is gone.
  const parentPid = Number(process.env.PI_HORDE_PARENT_PID);
  if (parentPid > 0) startParentWatchdog(parentPid);
  if (process.env.PI_HORDE_MEMBER === "1") {
    registerMemberTool(pi);
    return;
  }
  // pi's crash paths call process.exit without session_shutdown; this still runs.
  process.on("exit", terminateAllChildren);

  const state = createHordeState(pi);
  pi.registerCommand("agent-horde", {
    description:
      "Horde agents: '/agent-horde <count> <prompt>' to start; status, stop-hard, stop-clean, " +
      "pause, resume (each takes an optional member target)",
    getArgumentCompletions: (prefix) => controlCompletions(prefix, state.active),
    handler: (args, ctx) => handleHordeCommand(state, args, ctx),
  });
  registerReportRenderer(pi);
  pi.on("session_shutdown", () => shutdownHorde(state));
}
