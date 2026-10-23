import { errorMessage } from "../format.js";
import { recordEvent } from "../ledger/events.js";
import type { HordeEvent } from "../ledger/events.js";
import { LIFECYCLE_ATTEMPT } from "../run-graph.js";
import type { HordeRun } from "./types.js";
import { safeNotify } from "./ui.js";

export type LifecyclePhase = "discovery" | "repair" | "deliverable" | "post-mortem";

/**
 * Record a parent-side run event: spawn, exit, reset, stop, solved, phase, acceptance.
 * A failed audit write is reported, never thrown, so it cannot abort a spawn or a finalize.
 */
export async function recordLifecycle(
  run: HordeRun,
  action: string,
  payload: Record<string, unknown>,
): Promise<HordeEvent | undefined> {
  const ctx = { hordeDir: run.hordeDir, runId: run.id, actor: "parent", attempt: LIFECYCLE_ATTEMPT };
  try {
    return await recordEvent(ctx, action, { payload });
  } catch (error) {
    safeNotify(run, `horde ${run.id}: could not record ${action} (${errorMessage(error)})`, "error");
    return undefined;
  }
}

/** Phase boundaries let the run graph shade discovery, repair, and synthesis bands. */
export function recordPhase(
  run: HordeRun,
  phase: LifecyclePhase,
  state: "start" | "end",
  extra: Record<string, unknown> = {},
): Promise<HordeEvent | undefined> {
  return recordLifecycle(run, `phase-${state}`, { phase, ...extra });
}
