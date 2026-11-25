import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUsd } from "../format.js";
import { budgetReserve, totalUsage } from "../prompt.js";
import { requestCleanStop } from "./controls.js";
import type { HordeState, Swarm } from "./types.js";

/** Dollars the swarm's members have spent over every session, replaced ones included. */
export function swarmSpend(swarm: Pick<Swarm, "runs">): number {
  return swarm.runs.reduce((sum, run) => sum + totalUsage(run.members).cost, 0);
}

/** Turns a live member is expected to spend recording its work once a clean stop is requested. */
const WRAP_UP_TURNS = 8;

/**
 * Dollars held back for the wind-down right now: the budget's own reserve, or what the members
 * still running would spend on their wrap-up turns, each at its current session's cost per
 * turn, when that is more. Never more than half the budget.
 */
export function wrapUpReserve(swarm: Pick<Swarm, "runs" | "budget">): number {
  if (swarm.budget === undefined) return 0;
  const wrapUp = swarm.runs
    .flatMap((run) => run.members)
    .filter((member) => (member.status === "starting" || member.status === "running") && member.turns > 0)
    .reduce((sum, member) => sum + (WRAP_UP_TURNS * member.usage.cost) / member.turns, 0);
  return Math.min(swarm.budget / 2, Math.max(budgetReserve(swarm.budget), wrapUp));
}

/**
 * What one more session is expected to cost: the average of the sessions that have finished in
 * the swarm, or the reserve while none has.
 */
export function sessionEstimate(swarm: Pick<Swarm, "runs" | "budget">): number {
  const costs = swarm.runs.flatMap((run) => run.sessionCosts ?? []).filter((cost) => cost > 0);
  if (costs.length === 0) return swarm.budget === undefined ? 0 : budgetReserve(swarm.budget);
  return costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
}

/** Why the budget cannot pay for one more session. */
export interface BudgetShortfall {
  /** Dollars left above the reserve. */
  remaining: number;
  /** Expected cost of the session that was not started. */
  estimate: number;
}

/**
 * The admission check before a continuation, a reset or a repair attempt: undefined when the
 * budget left above the reserve covers the expected cost of a session, or when there is no budget.
 */
export function budgetShortfall(swarm: Pick<Swarm, "runs" | "budget">): BudgetShortfall | undefined {
  if (swarm.budget === undefined) return undefined;
  const remaining = Math.max(0, swarm.budget - wrapUpReserve(swarm) - swarmSpend(swarm));
  const estimate = sessionEstimate(swarm);
  return remaining < estimate ? { remaining, estimate } : undefined;
}

/**
 * `--budget`: once the members' combined spend comes within the wrap-up reserve of the ceiling,
 * clean-stop every horde still working. Called on every child event, so it fires on the usage
 * update that crosses the line. The flag is set before the first await so a burst of events
 * requests the stop once.
 * Hordes that already reported are skipped: a clean stop on one would re-arm a timer that
 * `stopRunTimers` cleared and record a stop-hard on a finished run.
 */
export function checkBudget(launch: { state: HordeState; swarm: Swarm; ctx: ExtensionCommandContext }): void {
  const { state, swarm, ctx } = launch;
  if (swarm.budget === undefined || swarm.budgetHit || state.disposed) return;
  const spent = swarmSpend(swarm);
  const reserve = wrapUpReserve(swarm);
  if (spent < swarm.budget - reserve) return;
  swarm.budgetHit = true;
  ctx.ui.notify(
    `horde ${swarm.id}: budget reached (${formatUsd(spent)} of ${formatUsd(swarm.budget)}, ` +
      `${formatUsd(reserve)} held for wrap-up); stopping`,
    "warning",
  );
  for (const run of swarm.runs) {
    if (run.stopped || run.reported || run.finalized) continue;
    void requestCleanStop(run, { kind: "all" }, ctx, { postmortem: false, label: "budget" });
  }
}
