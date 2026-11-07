import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUsd } from "../format.js";
import { totalUsage } from "../prompt.js";
import { requestCleanStop } from "./controls.js";
import type { HordeState, Swarm } from "./types.js";

/** Dollars the swarm's members have spent over every session, replaced ones included. */
export function swarmSpend(swarm: Pick<Swarm, "runs">): number {
  return swarm.runs.reduce((sum, run) => sum + totalUsage(run.members).cost, 0);
}

/**
 * `--budget`: once the members' combined spend reaches the threshold, clean-stop every horde
 * still working. Called on every child event, so it fires on the usage update that crosses the
 * line. The flag is set before the first await so a burst of events requests the stop once.
 * Hordes that already reported are skipped: a clean stop on one would re-arm a timer that
 * `stopRunTimers` cleared and record a stop-hard on a finished run.
 */
export function checkBudget(launch: { state: HordeState; swarm: Swarm; ctx: ExtensionCommandContext }): void {
  const { state, swarm, ctx } = launch;
  if (swarm.budget === undefined || swarm.budgetHit || state.disposed) return;
  const spent = swarmSpend(swarm);
  if (spent < swarm.budget) return;
  swarm.budgetHit = true;
  ctx.ui.notify(`horde ${swarm.id}: budget reached (${formatUsd(spent)} of ${formatUsd(swarm.budget)}); stopping`, "warning");
  for (const run of swarm.runs) {
    if (run.stopped || run.reported || run.finalized) continue;
    void requestCleanStop(run, { kind: "all" }, ctx, { postmortem: false, label: "budget" });
  }
}
