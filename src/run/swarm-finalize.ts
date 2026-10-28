import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "../format.js";
import { SWARM_REPORT_TYPE, swarmHordeRows, swarmReportMarkdown, swarmReportText } from "./swarm-report.js";
import type { SwarmReportDetails } from "./swarm-report.js";
import { runSwarmDeliverable } from "./synthesis.js";
import type { HordeRun, HordeState, Swarm } from "./types.js";
import { refreshSwarm, safeNotify, unmountWidget } from "./ui.js";

/** `SWARM.json`: the swarm's timeline for the dashboard once nothing is in memory. */
export interface SwarmRecord {
  id: string;
  prompt: string;
  hordes: number;
  count: number;
  startedAt: number;
  untilStop: boolean;
  partition: string[];
  runs: Array<{ label: string; runId: string; runDir: string; hordeDir: string; startedAt: number; endedAt?: number | undefined; outcome?: string | undefined }>;
  /** The merge step: when the swarm deliverable helper ran and whether it wrote anything. */
  merge?: { startedAt: number; endedAt?: number | undefined; written?: boolean | undefined } | undefined;
  endedAt?: number | undefined;
}

export function swarmRecord(swarm: Swarm): SwarmRecord {
  return {
    id: swarm.id,
    prompt: swarm.prompt,
    hordes: swarm.hordes,
    count: swarm.count,
    startedAt: swarm.startedAt,
    untilStop: swarm.untilStop === true,
    partition: swarm.partition ?? [],
    runs: swarm.runs.map((run) => ({
      label: `h${run.horde}`,
      runId: run.id,
      runDir: run.runDir,
      hordeDir: run.hordeDir,
      startedAt: run.startedAt,
      endedAt: run.finalized ? Math.max(run.startedAt, ...run.members.map((m) => m.endedAt ?? 0)) : undefined,
      outcome: run.outcome,
    })),
  };
}

/** Write a swarm file, reporting (not throwing) a failure so finalize keeps going. */
function writeSwarmFile(swarm: Swarm, name: string, content: string): void {
  if (!swarm.dir) return;
  try {
    fs.writeFileSync(path.join(swarm.dir, name), content, "utf-8");
  } catch (error) {
    safeNotify(swarm, `swarm ${swarm.id}: could not write ${name} (${errorMessage(error)})`, "error");
  }
}

export function writeSwarmRecord(swarm: Swarm, extra: Partial<SwarmRecord> = {}): void {
  writeSwarmFile(swarm, "SWARM.json", JSON.stringify({ ...swarmRecord(swarm), ...extra }, null, 2));
}

/**
 * A horde's members exited and its REPORT.md is written. Once every horde is there the swarm
 * slot frees, so a new launch can start while the (possibly slow) synthesis steps run.
 */
export function noteRunReported(state: HordeState, swarm: Swarm, run: HordeRun): void {
  run.reported = true;
  if (!swarm.runs.every((other) => other.reported === true)) return;
  if (state.active === swarm) state.active = undefined;
  state.finalizing = swarm;
}

/** The merged deliverable, REPORT.md, and the injected message of a swarm of several hordes. */
async function mergeSwarm(state: HordeState, swarm: Swarm): Promise<void> {
  swarm.finalizing = ["merge"];
  refreshSwarm(swarm);
  const merge: NonNullable<SwarmRecord["merge"]> = { startedAt: Date.now() };
  writeSwarmRecord(swarm, { merge });
  swarm.deliverable = process.env.PI_HORDE_DELIVERABLE === "off" ? undefined : await runSwarmDeliverable(state, swarm);
  if (swarm.deliverable) writeSwarmFile(swarm, "DELIVERABLE.md", swarm.deliverable);
  const now = Date.now();
  merge.endedAt = now;
  merge.written = Boolean(swarm.deliverable);
  writeSwarmFile(swarm, "REPORT.md", swarmReportMarkdown(swarm, now));
  writeSwarmRecord(swarm, { merge, endedAt: now });
  if (state.disposed) return;
  const details: SwarmReportDetails = {
    swarmId: swarm.id,
    elapsedMs: now - swarm.startedAt,
    hordes: swarmHordeRows(swarm, now),
    deliverable: swarm.deliverable,
  };
  const content = [swarmReportText(swarm, now), ...(swarm.deliverable ? ["## Deliverable", "", swarm.deliverable] : [])].join("\n\n");
  // A hard stop of every horde keeps the parent idle, as it does for one horde.
  const triggerTurn = swarm.runs.some((run) => run.cleanStopNames.length > 0 || !run.stopped);
  state.pi.sendMessage(
    { customType: SWARM_REPORT_TYPE, content, display: true, details },
    { deliverAs: "followUp", triggerTurn },
  );
  safeNotify(swarm, `swarm ${swarm.id} finished`, "info");
}

/**
 * A horde's finalize completed, synthesis included. The swarm step runs once every horde is
 * done: a swarm of one has nothing to merge and only releases the widget.
 */
export async function noteRunFinalized(state: HordeState, swarm: Swarm, run: HordeRun): Promise<void> {
  run.finalized = true;
  if (!swarm.runs.every((other) => other.finalized === true)) {
    refreshSwarm(swarm);
    return;
  }
  try {
    if (swarm.dir && !state.disposed) await mergeSwarm(state, swarm);
  } catch (error) {
    safeNotify(swarm, `swarm ${swarm.id} failed to finalize: ${errorMessage(error)}`, "error");
  } finally {
    swarm.finalizing = undefined;
    if (state.active === swarm) state.active = undefined;
    if (state.finalizing === swarm) state.finalizing = undefined;
    unmountWidget(swarm);
  }
}
