import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { USAGE, parseHordeArgs } from "../args.js";
import { clearCleanStop } from "../ledger/run-signals.js";
import { terminateAllChildren } from "../member.js";
import { formatStatusReport } from "../prompt.js";
import { requestCleanStop, setPaused, stopHard, targetMembers } from "./controls.js";
import { stopRunTimers } from "./finalize.js";
import { closeDashboard, startRun } from "./launch.js";
import type { HordeRun, HordeState } from "./types.js";
import { unmountWidget } from "./ui.js";

/** The active run, or undefined after telling the user there is none. */
function requireActive(state: HordeState, ctx: ExtensionCommandContext): HordeRun | undefined {
  if (!state.active) ctx.ui.notify("no horde run is active", "info");
  return state.active;
}

/** Handle one `/agent-horde` invocation. */
export async function handleHordeCommand(
  state: HordeState,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseHordeArgs(args);
  switch (parsed.kind) {
    case "usage":
      if (parsed.error) ctx.ui.notify(`${parsed.error}\n${USAGE}`, "error");
      else ctx.ui.notify(USAGE, "info");
      return;
    case "help":
      ctx.ui.notify(USAGE, "info");
      return;
    case "status": {
      const run = requireActive(state, ctx);
      const members = run && targetMembers(run, parsed.target, ctx);
      if (run && members) ctx.ui.notify(formatStatusReport({ ...run, members }), "info");
      return;
    }
    case "stop": {
      const run = requireActive(state, ctx);
      if (!run) return;
      if (parsed.mode === "clean") {
        await requestCleanStop(run, parsed.target, ctx, {
          graceMs: parsed.graceMs,
          postmortem: parsed.postmortem,
        });
      } else {
        stopHard(run, parsed.target, ctx);
      }
      return;
    }
    case "pause":
    case "resume": {
      const run = requireActive(state, ctx);
      if (run) setPaused(run, parsed.target, ctx, parsed.kind === "pause");
      return;
    }
    case "run":
      if (state.active || state.starting) {
        ctx.ui.notify(
          `horde ${state.active?.id ?? ""} is still active; use /agent-horde status or /agent-horde stop-hard`.replace("  ", " "),
          "error",
        );
        return;
      }
      await startRun(state, ctx, parsed);
  }
}

/** Session teardown: abort the active run and every helper, without finalizing. */
export function shutdownHorde(state: HordeState): void {
  state.disposed = true;
  process.off("exit", terminateAllChildren);
  closeDashboard(state);
  const run = state.active;
  state.active = undefined;
  if (!run) return;
  run.stopped = true;
  run.userStop = true;
  run.postmortemAbort?.abort();
  run.deliverableAbort?.abort();
  stopRunTimers(run);
  clearCleanStop(run.runDir);
  run.controller.abort();
  try {
    unmountWidget(run);
  } catch {
    // The UI is already being torn down.
  }
  run.ui = undefined;
}
