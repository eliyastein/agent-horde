import { formatElapsed, oneLine } from "./format.js";
import type { GraphNode, RunGraph } from "./run-graph.js";

const LABEL_MAX = 48;
/** Mermaid's default flowchart ceiling; the header warns when an export approaches it. */
const MERMAID_MAX_EDGES = 500;
const EDGE_WARN = 450;

const ENTITIES: Record<string, string> = { "&": "#amp;", '"': "#quot;", "<": "#lt;", ">": "#gt;", "|": "#124;" };

/** Node ids may only use letters, digits, and underscores. */
export function mermaidId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_");
}

function label(text: string): string {
  return oneLine(text, LABEL_MAX).replace(/[&"<>|]/g, (ch) => ENTITIES[ch] ?? ch);
}

function edgeLabel(text: string): string {
  return oneLine(text, 24).replace(/[|"]/g, "/");
}

/** Tooltips are plain strings in quotes: no quotes, backslashes, or markup inside. */
function tooltip(text: string): string {
  return oneLine(text, 60).replace(/["\\<>]/g, "'");
}

function nodeLine(node: GraphNode, indent: string): string {
  const text = node.placeholder ? `${node.label} (prior)` : `${node.label}: ${node.title}`;
  return `${indent}${mermaidId(node.id)}["${label(text)}"]`;
}

function laneRef(graph: RunGraph, laneId: string): string {
  return mermaidId(graph.lanes.some((lane) => lane.id === laneId) ? laneId : "parent");
}

/** Markers fold into their lane: a claim by member-3 is an edge from member_3. */
function edgeLines(graph: RunGraph): string[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    const source = from.marker ? laneRef(graph, from.lane) : mermaidId(from.id);
    const target = to.marker ? laneRef(graph, to.lane) : mermaidId(to.id);
    if (source === target) continue;
    const arrow = from.marker || to.marker ? "-.->" : "-->";
    const line = `  ${source} ${arrow}|${edgeLabel(edge.label)}| ${target}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

function phaseTitle(graph: RunGraph, phase: { id: string; from: number; to: number }): string {
  return `${phase.id} +${formatElapsed(phase.from - graph.start)} to +${formatElapsed(phase.to - graph.start)}`;
}

function entityLines(graph: RunGraph): string[] {
  const entities = graph.nodes.filter((node) => !node.marker);
  const used = new Set<string>();
  const lines: string[] = [];
  for (const phase of graph.phases) {
    const inside = entities.filter((node) => !used.has(node.id) && node.at >= phase.from && node.at < phase.to);
    if (inside.length === 0) continue;
    lines.push(`  subgraph ${mermaidId(`phase_${phase.id}`)}["${label(phaseTitle(graph, phase))}"]`);
    for (const node of inside) {
      used.add(node.id);
      lines.push(nodeLine(node, "    "));
    }
    lines.push("  end");
  }
  for (const node of entities) if (!used.has(node.id)) lines.push(nodeLine(node, "  "));
  return lines;
}

function clickLines(graph: RunGraph, base: string): string[] {
  const lines: string[] = [];
  for (const lane of graph.lanes) {
    if (lane.href) lines.push(`  click ${mermaidId(lane.id)} "${base}${lane.href}" "${tooltip(lane.label)}"`);
  }
  for (const node of graph.nodes) {
    if (!node.marker && node.href) lines.push(`  click ${mermaidId(node.id)} "${base}${node.href}" "${tooltip(node.title)}"`);
  }
  return lines;
}

/**
 * A structural Mermaid flowchart: entities grouped by phase, members as nodes, actions folded
 * into edges. Time is not represented; the dashboard swimlane is the temporal view.
 */
export function renderRunGraphMermaid(graph: RunGraph, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const edges = edgeLines(graph);
  const entities = graph.nodes.filter((node) => !node.marker).length;
  const header = [
    `%% Horde run ${graph.runId}: structural graph generated from events.jsonl.`,
    `%% ${entities} entities, ${edges.length} edges, ${graph.lanes.length} lanes. Temporal view: ${base}/runs/${encodeURIComponent(graph.runId)}/graph`,
  ];
  if (edges.length > EDGE_WARN) header.push(`%% Mermaid renders at most ${MERMAID_MAX_EDGES} edges by default; raise maxEdges for this graph.`);
  const lanes = graph.lanes.map((lane) => `    ${mermaidId(lane.id)}["${label(lane.label)}"]`);
  return [
    ...header,
    "flowchart LR",
    '  subgraph lanes["members"]',
    ...lanes,
    "  end",
    ...entityLines(graph),
    ...edges,
    ...clickLines(graph, base),
    "",
  ].join("\n");
}

/** GRAPH.md: the Mermaid export with a short header, written next to REPORT.md at finalize. */
export function runGraphMarkdown(graph: RunGraph, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const entities = graph.nodes.filter((node) => !node.marker).length;
  const phases = graph.phases.map((phase) => phaseTitle(graph, phase)).join("; ") || "none recorded";
  return [
    `# Run graph ${graph.runId}`,
    "",
    `Generated from events.jsonl: ${entities} entities, ${graph.edges.length} edges, ${graph.lanes.length} lanes.`,
    `Phases: ${phases}.`,
    "",
    "Structural view: edges show what was claimed, filed, reviewed, requested, and delivered. The",
    `dashboard swimlane at ${base}/runs/${encodeURIComponent(graph.runId)}/graph is the temporal view; node links open`,
    "it when the dashboard is running.",
    "",
    "```mermaid",
    renderRunGraphMermaid(graph, base).trimEnd(),
    "```",
    "",
  ].join("\n");
}
