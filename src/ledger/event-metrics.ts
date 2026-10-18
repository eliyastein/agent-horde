import type { HordeEvent } from "./events.js";

export interface SolvedConfirmations {
  /** Members whose confirm-solved was the one credited for a proposal revision. */
  credited: string[];
  /** Members whose confirm-solved arrived after the credited one and changed nothing. */
  redundant: string[];
}

/** The report shows how many members spent a confirmation on an already validated proposal. */
export function solvedConfirmations(events: HordeEvent[]): SolvedConfirmations {
  const out: SolvedConfirmations = { credited: [], redundant: [] };
  for (const event of events) {
    if (event.action !== "confirm-solved") continue;
    if (event.outcome === "applied") out.credited.push(event.actor);
    else if (event.outcome === "noop") out.redundant.push(event.actor);
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
