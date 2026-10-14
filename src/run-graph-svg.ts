import { formatElapsed } from "./format.js";
import type { EdgeTone, GraphLane, GraphNode, GraphNodeKind, RunGraph } from "./run-graph.js";

/** Plot width in pixels and the visible window as millisecond offsets from the run start. */
export interface GraphWindow {
  width: number;
  from: number;
  /** Zero or anything not after `from` means "to the end of the run". */
  to: number;
}

const LABEL_W = 150;
const PAD = 6;
const ROW_H = 18;
const BOX_H = 14;
const CHAR_W = 6.6;
const MIN_BOX_W = 24;
const DOT_R = 3.5;
const GAP = 4;
const HEADER_H = 36;
const AXIS_H = 18;
const TICK_STEPS_MS = [5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000];
const MAX_TICKS = 14;

const TONE_COLORS: Record<EdgeTone, string> = {
  structure: "#000", collaboration: "#1f5fbf", verification: "#1a7f37", negative: "#c62828", lifecycle: "#888",
};
const KIND_FILLS: Record<GraphNodeKind, string> = {
  idea: "#fff3bf", finding: "#ffd8a8", fact: "#d3f9d8", resource: "#e5dbff", claim: "#c5f6fa", artifact: "#ffe3e3",
  review: "#d0ebff", message: "#fff0f6", evidence: "#e9ecef", action: "#777", lifecycle: "#999",
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function e(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

function px(value: number): string {
  return String(Math.round(value * 10) / 10);
}

interface Placed {
  node: GraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LaneBand {
  lane: GraphLane;
  y: number;
  h: number;
}

interface Layout {
  width: number;
  height: number;
  t0: number;
  t1: number;
  bands: LaneBand[];
  placed: Map<string, Placed>;
  x: (t: number) => number;
}

function nodeWidth(node: GraphNode): number {
  return node.marker ? DOT_R * 2 : Math.max(MIN_BOX_W, Math.round(node.label.length * CHAR_W) + 8);
}

function windowOf(graph: RunGraph, window: GraphWindow): { t0: number; t1: number } {
  const duration = graph.end - graph.start;
  const t0 = graph.start + Math.min(Math.max(0, window.from), duration);
  const requested = window.to > window.from ? graph.start + Math.min(window.to, duration) : graph.end;
  return { t0, t1: requested > t0 ? requested : t0 + 1_000 };
}

/** Rows within a lane: a node takes the first row whose last occupant ends before it starts. */
function packLane(nodes: GraphNode[], x: (t: number) => number, top: number): { placed: Placed[]; rows: number } {
  const rowEnds: number[] = [];
  const placed: Placed[] = [];
  for (const node of nodes) {
    const w = nodeWidth(node);
    const left = node.marker ? x(node.at) - DOT_R : x(node.at);
    let row = rowEnds.findIndex((end) => end + GAP <= left);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = left + w;
    placed.push({ node, x: left, y: top + PAD + row * ROW_H, w, h: node.marker ? DOT_R * 2 : BOX_H });
  }
  return { placed, rows: Math.max(1, rowEnds.length) };
}

function layoutGraph(graph: RunGraph, window: GraphWindow): Layout {
  const { t0, t1 } = windowOf(graph, window);
  const plotW = window.width;
  const x = (t: number): number => LABEL_W + Math.min(Math.max(0, (t - t0) / (t1 - t0)), 1) * plotW;
  const visible = graph.nodes.filter((node) => node.at >= t0 && node.at <= t1).sort((a, b) => a.at - b.at);
  const placed = new Map<string, Placed>();
  const bands: LaneBand[] = [];
  let y = HEADER_H;
  for (const lane of graph.lanes) {
    const own = visible.filter((node) => node.lane === lane.id);
    const packed = packLane(own, x, y);
    for (const item of packed.placed) placed.set(item.node.id, item);
    const h = PAD * 2 + packed.rows * ROW_H;
    bands.push({ lane, y, h });
    y += h;
  }
  return { width: LABEL_W + plotW + PAD, height: y + AXIS_H, t0, t1, bands, placed, x };
}

function renderDefs(): string {
  const markers = (Object.keys(TONE_COLORS) as EdgeTone[]).map((tone) =>
    `<marker id="arrow-${tone}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
    `<path d="M0,0 L8,4 L0,8 z" fill="${TONE_COLORS[tone]}"/></marker>`,
  );
  return `<defs>${markers.join("")}</defs>`;
}

function renderPhases(graph: RunGraph, layout: Layout): string {
  const bottom = layout.height - AXIS_H;
  return graph.phases
    .map((phase, index) => {
      const from = Math.max(phase.from, layout.t0);
      const to = Math.min(phase.to, layout.t1);
      if (to <= from) return "";
      const x0 = layout.x(from);
      const w = Math.max(1, layout.x(to) - x0);
      const label = `${phase.id} +${formatElapsed(phase.from - graph.start)} to +${formatElapsed(phase.to - graph.start)}`;
      return (
        `<rect class="phase${index % 2 ? " phase-alt" : ""}" x="${px(x0)}" y="${HEADER_H - 16}" width="${px(w)}" height="${px(bottom - HEADER_H + 16)}"/>` +
        `<text x="${px(x0 + 3)}" y="${HEADER_H - 5}" class="phase-label"><title>${e(label)}</title>${e(label)}</text>`
      );
    })
    .join("");
}

function renderLanes(layout: Layout): string {
  return layout.bands
    .map(({ lane, y, h }) => {
      const title = [lane.label, lane.role ? `role: ${lane.role}` : "", lane.status ? `status: ${lane.status}` : ""].filter(Boolean).join("; ");
      const text = `<text x="4" y="${px(y + PAD + 10)}"><title>${e(title)}</title>${e(lane.label)}</text>`;
      const label = lane.href ? `<a href="${e(lane.href)}">${text}</a>` : text;
      return `<line class="lane-line" x1="0" y1="${px(y + h)}" x2="${px(layout.width)}" y2="${px(y + h)}"/>${label}`;
    })
    .join("");
}

function renderAxis(graph: RunGraph, layout: Layout): string {
  const span = layout.t1 - layout.t0;
  const step = TICK_STEPS_MS.find((candidate) => span / candidate <= MAX_TICKS) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
  const firstTick = graph.start + Math.ceil((layout.t0 - graph.start) / step) * step;
  const parts: string[] = [];
  const y = layout.height - AXIS_H;
  for (let t = firstTick; t <= layout.t1; t += step) {
    const x = layout.x(t);
    parts.push(`<line class="tick" x1="${px(x)}" y1="${HEADER_H}" x2="${px(x)}" y2="${px(y)}"/>`);
    parts.push(`<text x="${px(x + 2)}" y="${px(y + 12)}" class="tick-label">+${e(formatElapsed(t - graph.start))}</text>`);
  }
  return parts.join("");
}

function anchor(item: Placed, towardsRight: boolean): [number, number] {
  const cy = item.y + item.h / 2;
  if (item.node.marker) return [item.x + item.w / 2, cy];
  return [towardsRight ? item.x + item.w : item.x, cy];
}

function renderEdges(graph: RunGraph, layout: Layout): string {
  return graph.edges
    .map((edge) => {
      const from = layout.placed.get(edge.from);
      const to = layout.placed.get(edge.to);
      if (!from || !to) return "";
      const rightwards = to.x + to.w / 2 >= from.x + from.w / 2;
      const [x1, y1] = anchor(from, rightwards);
      const [x2, y2] = anchor(to, !rightwards);
      const d = Math.min(60, Math.max(12, Math.abs(x2 - x1) / 2)) * (rightwards ? 1 : -1);
      const path = `M${px(x1)},${px(y1)} C${px(x1 + d)},${px(y1)} ${px(x2 - d)},${px(y2)} ${px(x2)},${px(y2)}`;
      return `<path class="e e-${edge.tone}" marker-end="url(#arrow-${edge.tone})" d="${path}"><title>${e(`${edge.from} ${edge.label} ${edge.to}`)}</title></path>`;
    })
    .join("");
}

function renderNode(item: Placed): string {
  const { node } = item;
  const title = `<title>${e(node.title)}</title>`;
  let shape: string;
  if (node.marker) {
    const cls = `m m-${node.outcome}`;
    shape = `<circle class="${cls}" cx="${px(item.x + DOT_R)}" cy="${px(item.y + BOX_H / 2)}" r="${DOT_R}" fill="${KIND_FILLS[node.kind]}"/>`;
  } else {
    const cls = `n n-${node.kind}${node.placeholder ? " n-prior" : ""}`;
    shape =
      `<rect class="${cls}" x="${px(item.x)}" y="${px(item.y)}" width="${px(item.w)}" height="${BOX_H}" rx="2" fill="${KIND_FILLS[node.kind]}"/>` +
      `<text x="${px(item.x + 4)}" y="${px(item.y + 10.5)}">${e(node.label)}</text>`;
  }
  const body = `${title}${shape}`;
  return node.href ? `<a href="${e(node.href)}">${body}</a>` : `<g>${body}</g>`;
}

/** The swimlane: one row band per lane, time left to right, every node a link into the dashboard. */
export function renderRunGraphSvg(graph: RunGraph, window: GraphWindow): string {
  const layout = layoutGraph(graph, window);
  const nodes = [...layout.placed.values()].map(renderNode).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px(layout.width)}" height="${px(layout.height)}" ` +
    `viewBox="0 0 ${px(layout.width)} ${px(layout.height)}" font-family="ui-monospace,Menlo,monospace" font-size="11">` +
    `${renderDefs()}${renderPhases(graph, layout)}${renderLanes(layout)}${renderAxis(graph, layout)}` +
    `${renderEdges(graph, layout)}${nodes}</svg>`
  );
}

/** Styles for the swimlane; the page inlines them, which the dashboard CSP permits. */
export const GRAPH_CSS =
  ".graph{overflow:auto;border:1px solid #000;margin:4px 0;background:#fff}" +
  "svg text{fill:#000}svg .phase{fill:#000;opacity:.04}svg .phase-alt{opacity:.09}svg .phase-label{font-weight:bold}" +
  "svg .lane-line{stroke:#bbb}svg .tick{stroke:#e5e5e5}svg .tick-label{fill:#555}" +
  "svg .n{stroke:#000;stroke-width:1}svg .n-prior{stroke-dasharray:3 2}" +
  "svg .m{stroke:#333;stroke-width:1}svg .m-rejected{stroke:#c62828;stroke-width:2}svg .m-noop{stroke-dasharray:2 1}" +
  "svg a:hover .n,svg a:hover .m{stroke-width:2.5}svg a:hover text{text-decoration:underline}" +
  `svg .e{fill:none;stroke-width:1;opacity:.8}${(Object.keys(TONE_COLORS) as EdgeTone[]).map((tone) => `svg .e-${tone}{stroke:${TONE_COLORS[tone]}}`).join("")}` +
  // Idea and finding structure spans the whole run; keep it legible but behind the collaboration.
  "svg .e-structure{opacity:.35}" +
  ".legend span{display:inline-block;border:1px solid #000;padding:0 5px;margin:0 4px 2px 0}";

function swatch(label: string, fill: string, extra = ""): string {
  return `<span style="background:${fill}${extra}">${e(label)}</span>`;
}

/** The legend the graph page shows above the swimlane. */
export function graphLegendHtml(): string {
  const kinds = (Object.keys(KIND_FILLS) as GraphNodeKind[])
    .filter((kind) => kind !== "action" && kind !== "lifecycle")
    .map((kind) => swatch(kind, KIND_FILLS[kind]));
  const markers = [
    swatch("member action", KIND_FILLS.action, ";color:#fff"),
    swatch("parent lifecycle", KIND_FILLS.lifecycle, ";color:#fff"),
    swatch("rejected", "#fff", ";border-color:#c62828;color:#c62828"),
    swatch("prior run / plan seed", "#fff", ";border-style:dashed"),
  ];
  const edges = (Object.keys(TONE_COLORS) as EdgeTone[]).map((tone) => swatch(tone, "#fff", `;color:${TONE_COLORS[tone]};border-color:${TONE_COLORS[tone]}`));
  return `<p class="legend">boxes: ${kinds.join("")}</p><p class="legend">dots: ${markers.join("")}</p><p class="legend">edges: ${edges.join("")}</p>`;
}
