import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { USAGE, parseHordeArgs } from "../args.js";
import type { HordeTarget } from "../args.js";
import { clearCleanStop } from "../ledger/run-signals.js";
import { terminateAllChildren } from "../member.js";
import { formatStatusReport } from "../prompt.js";
import { requestCleanStop, resolveTargets, setPaused, stopHard, targetMembers } from "./controls.js";
import type { RunSelection } from "./controls.js";
import { stopRunTimers } from "./finalize.js";
import { closeDashboard, startSwarm } from "./launch.js";
import type { HordeState, Swarm } from "./types.js";
import { unmountWidget } from "./ui.js";

/** The active swarm, or undefined after telling the user there is none. */
function requireActive(state: HordeState, ctx: ExtensionCommandContext): Swarm | undefined {
  if (!state.active) ctx.ui.notify("no horde run is active", "info");
  return state.active;
}

/** The runs and members a control command addresses, or undefined after the user was told why not. */
function select(state: HordeState, target: HordeTarget, ctx: ExtensionCommandContext): RunSelection[] | undefined {
  const swarm = requireActive(state, ctx);
  if (!swarm) return undefined;
  const selections = resolveTargets(swarm, target, ctx);
  if (selections && selections.length === 0) ctx.ui.notify("the target selects no members", "info");
  return selections && selections.length > 0 ? selections : undefined;
}

function showStatus(selections: RunSelection[], ctx: ExtensionCommandContext): void {
  const blocks: string[] = [];
  for (const { run, target } of selections) {
    const members = targetMembers(run, target, ctx);
    if (members) blocks.push(formatStatusReport({ ...run, members }));
  }
  if (blocks.length > 0) ctx.ui.notify(blocks.join("\n\n"), "info");
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
      const selections = select(state, parsed.target, ctx);
      if (selections) showStatus(selections, ctx);
      return;
    }
    case "stop": {
      const selections = select(state, parsed.target, ctx);
      if (!selections) return;
      for (const { run, target } of selections) {
        if (parsed.mode === "clean") {
          await requestCleanStop(run, target, ctx, { graceMs: parsed.graceMs, postmortem: parsed.postmortem });
        } else {
          stopHard(run, target, ctx);
        }
      }
      return;
    }
    case "pause":
    case "resume": {
      const selections = select(state, parsed.target, ctx);
      if (!selections) return;
      for (const { run, target } of selections) setPaused(run, target, ctx, parsed.kind === "pause");
      return;
    }
    case "run":
      if (state.active || state.starting) {
        const noun = state.active && state.active.hordes > 1 ? "swarm" : "horde";
        ctx.ui.notify(
          `${noun} ${state.active?.id ?? ""} is still active; use /agent-horde status or /agent-horde stop-hard`.replace("  ", " "),
          "error",
        );
        return;
      }
      await startSwarm(state, ctx, parsed);
  }
}

function abortSwarm(swarm: Swarm): void {
  swarm.deliverableAbort?.abort();
  for (const run of swarm.runs) {
    run.stopped = true;
    run.userStop = true;
    run.postmortemAbort?.abort();
    run.deliverableAbort?.abort();
    stopRunTimers(run);
    clearCleanStop(run.runDir);
    run.controller.abort();
    run.ui = undefined;
  }
  try {
    unmountWidget(swarm);
  } catch {
    // The UI is already being torn down.
  }
  swarm.ui = undefined;
}

/** Session teardown: abort the active swarm and every helper, without finalizing. */
export function shutdownHorde(state: HordeState): void {
  state.disposed = true;
  process.off("exit", terminateAllChildren);
  closeDashboard(state);
  state.plannerAbort?.abort();
  const active = state.active;
  const finalizing = state.finalizing;
  state.active = undefined;
  state.finalizing = undefined;
  if (active) abortSwarm(active);
  if (finalizing && finalizing !== active) abortSwarm(finalizing);
}
