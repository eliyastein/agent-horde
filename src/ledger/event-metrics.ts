import type { HordeEvent } from "./events.js";

export interface SolvedConfirmations {
  /** Members whose confirm-solved was the one credited for a proposal revision. */
  credited: string[];
  /** Members who confirmed the same proposal after the credited one; their text is in the event. */
  additional: string[];
}

/** The report names every member that confirmed the proposal, not only the one credited. */
export function solvedConfirmations(events: HordeEvent[]): SolvedConfirmations {
  const out: SolvedConfirmations = { credited: [], additional: [] };
  for (const event of events) {
    if (event.action !== "confirm-solved" || event.outcome === "rejected" || event.outcome === "intent") continue;
    const result = event.payload.result as { confirmation?: unknown } | undefined;
    if (event.outcome === "applied" && result?.confirmation !== "additional") out.credited.push(event.actor);
    else out.additional.push(event.actor);
  }
  return out;
}

export function ideaCreationCount(events: HordeEvent[]): number {
  return events.filter((event) => event.action === "idea" && event.outcome === "applied").length;
}

/** Idea creations the dedup folded into an existing idea, by that idea's id, most absorbed first. */
export function absorbedIdeaCreations(events: HordeEvent[]): Array<{ id: number; count: number }> {
  const counts = new Map<number, number>();
  for (const event of events) {
    if (event.action !== "idea" || event.outcome !== "noop") continue;
    const id = (event.payload.result as { id?: unknown } | undefined)?.id;
    if (typeof id === "number") counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id - b.id);
}
