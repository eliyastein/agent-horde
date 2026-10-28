import { oneLine } from "./format.js";
import type { HordeEvent } from "./ledger/events.js";
import { LIFECYCLE_ATTEMPT, eventHref } from "./run-graph.js";
import type { GraphEdge, GraphLane, GraphNode, RunGraph } from "./run-graph.js";

/** One horde's events and where its run page is. */
export interface SwarmGraphHorde {
  label: string;
  runId: string;
  events: HordeEvent[];
  status?: string | undefined;
}

export interface SwarmGraphInput {
  swarmId: string;
  startedAt: number;
  hordes: SwarmGraphHorde[];
  /** The swarm's merge step, once it started. */
  merge?: { startedAt: number; endedAt?: number | undefined; written?: boolean | undefined } | undefined;
  /** Graph end for a live swarm (epoch ms); a finished swarm ends at its last event. */
  now?: number | undefined;
}

const SWARM_LANE = "swarm";

/** The parent lifecycle actions that mark a horde's progress; member-level churn stays on the run graph. */
const PHASE_ACTIONS = new Set([
  "run-start", "phase-start", "phase-end", "stop-clean", "stop-hard", "solved-validated", "solved-banked",
  "solved-contested", "acceptance", "run-end",
]);

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function labelOf(event: HordeEvent): [string, string] {
  const p = event.payload;
  switch (event.action) {
    case "run-start": return ["start", `${String(p.count ?? "?")} members${str(p.slice) ? `; workstream: ${oneLine(str(p.slice) ?? "", 160)}` : ""}`];
    case "phase-start": return [`${str(p.phase) ?? "phase"} start`, `${str(p.phase) ?? "phase"} started`];
    case "phase-end": return [`${str(p.phase) ?? "phase"} end`, `${str(p.phase) ?? "phase"} ended`];
    case "stop-clean": return [`stop-clean (${str(p.label) ?? "stop-clean"})`, "clean stop requested"];
    case "stop-hard": return [`stop-hard (${str(p.by) ?? "user"})`, "members terminated"];
    case "solved-validated": return ["solved validated", str(p.validator) ? `by ${str(p.validator)}` : "without a separate validator"];
    case "solved-banked": return [`solved banked (round ${String(p.round ?? "?")})`, "the run continues until stopped"];
    case "solved-contested": return ["solved contested", `by ${str(p.member) ?? ""}`];
    case "acceptance": return [`acceptance ${str(p.status) ?? ""}`.trim(), `${String(p.issues ?? 0)} issues`];
    case "run-end": return ["end", `outcome ${str(p.outcome) ?? "unknown"}`];
    default: return [event.action, ""];
  }
}

function hordeNodes(horde: SwarmGraphHorde): GraphNode[] {
  return horde.events
    .filter((event) => event.attempt === LIFECYCLE_ATTEMPT && event.outcome === "applied" && PHASE_ACTIONS.has(event.action))
    .map((event) => {
      const [label, title] = labelOf(event);
      const at = Date.parse(event.at);
      return {
        id: `${horde.label}:${event.eventId}`,
        kind: "lifecycle" as const,
        action: event.action,
        label,
        title: `${horde.label} ${event.eventId} ${title}`.trim(),
        lane: horde.label,
        at: Number.isFinite(at) ? at : 0,
        eventId: event.eventId,
        href: eventHref(horde.runId, event.seq),
        outcome: "applied" as const,
        marker: true,
        placeholder: false,
      };
    })
    .filter((node) => node.at > 0);
}

function mergeNodes(input: SwarmGraphInput): GraphNode[] {
  const merge = input.merge;
  if (!merge) return [];
  const node = (id: string, label: string, title: string, at: number): GraphNode => ({
    id, kind: "lifecycle", action: id, label, title, lane: SWARM_LANE, at, eventId: "",
    href: `/swarms/${encodeURIComponent(input.swarmId)}`, outcome: "applied", marker: true, placeholder: false,
  });
  const nodes = [node("merge-start", "merge start", "merging the hordes' deliverables", merge.startedAt)];
  if (merge.endedAt !== undefined) {
    nodes.push(node("merge-end", `merge end${merge.written === false ? " (no deliverable)" : ""}`,
      merge.written === false ? "the swarm deliverable was not written" : "DELIVERABLE.md written", merge.endedAt));
  }
  return nodes;
}

/** One lane per horde plus the swarm lane, so the hordes' phases line up against the merge step. */
export function buildSwarmGraph(input: SwarmGraphInput): RunGraph {
  const perHorde = input.hordes.map((horde) => hordeNodes(horde));
  const nodes = [...perHorde.flat(), ...mergeNodes(input)].sort((a, b) => a.at - b.at);
  const edges: GraphEdge[] = [];
  if (input.merge) {
    for (const horde of perHorde) {
      const end = horde.find((node) => node.action === "run-end");
      if (end) edges.push({ from: end.id, to: "merge-start", label: "merged", tone: "lifecycle" });
    }
  }
  const lanes: GraphLane[] = [
    { id: SWARM_LANE, label: SWARM_LANE },
    ...input.hordes.map((horde) => ({
      id: horde.label,
      label: `${horde.label} ${horde.runId}`,
      href: `/runs/${encodeURIComponent(horde.runId)}`,
      status: horde.status,
    })),
  ];
  const start = input.startedAt;
  const latest = Math.max(input.now ?? 0, input.merge?.endedAt ?? 0, ...nodes.map((node) => node.at));
  const end = latest > start ? latest : start + 1_000;
  const hordeTimes = perHorde.flat().map((node) => node.at);
  const live = input.now !== undefined && !input.hordes.every((horde) => horde.events.some((event) => event.action === "run-end"));
  return {
    runId: input.swarmId,
    start,
    end,
    membersEnd: live || hordeTimes.length === 0 ? end : Math.min(end, Math.max(start, ...hordeTimes)),
    lanes,
    phases: [],
    nodes,
    edges,
  };
}
