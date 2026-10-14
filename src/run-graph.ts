import { detailKey, oneLine } from "./format.js";
import type { HordeEvent } from "./ledger/events.js";

export type GraphNodeKind =
  | "idea" | "finding" | "fact" | "resource" | "claim" | "artifact" | "review" | "message"
  | "evidence" | "action" | "lifecycle";
export type GraphOutcome = "applied" | "rejected" | "noop";
export type EdgeTone = "structure" | "collaboration" | "verification" | "negative" | "lifecycle";

export interface GraphNode {
  /** Entity id (F3, I4, Q9, ...) or the event id for an action on something. */
  id: string;
  kind: GraphNodeKind;
  /** The event action that produced the node. */
  action: string;
  label: string;
  /** Hover text; raw, escaped by the renderers. */
  title: string;
  /** "parent" or a member name. */
  lane: string;
  at: number;
  eventId: string;
  /** Dashboard path, relative to the server root. */
  href: string;
  outcome: GraphOutcome;
  /** A dot in the lane rather than a labelled box: an action on a thing, not a thing. */
  marker: boolean;
  /** Referenced by this run but created before it or seeded by its plan. */
  placeholder: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
  tone: EdgeTone;
}

export interface GraphLane {
  id: string;
  label: string;
  href?: string | undefined;
  role?: string | undefined;
  status?: string | undefined;
}

export interface GraphPhase {
  id: string;
  from: number;
  to: number;
}

export interface RunGraph {
  runId: string;
  start: number;
  end: number;
  lanes: GraphLane[];
  phases: GraphPhase[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphMember {
  name: string;
  status?: string | undefined;
}

export interface RunGraphInput {
  runId: string;
  events: HordeEvent[];
  /** Members known from memory or disk, so lanes exist before their first event. */
  members?: GraphMember[] | undefined;
  /** Run start when no run-start event exists (epoch ms). */
  startedAt?: number | undefined;
  /** Graph end for a live run (epoch ms); a finished run ends at its last event. */
  now?: number | undefined;
}

type Payload = Record<string, unknown>;
type Handler = (draft: Draft, event: HordeEvent, input: Payload, result: Payload) => void;

interface Draft {
  runId: string;
  start: number;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  phases: Map<string, { from?: number | undefined; to?: number | undefined }>;
  roles: Map<string, string>;
  verifier?: string | undefined;
  runEnd?: number | undefined;
  lastSolved?: string | undefined;
}

const ENTITY_RE = /^([A-Z])(\d+(?:-\d+)?)$/;
const ENTITY_KINDS: Record<string, GraphNodeKind> = {
  I: "idea", F: "finding", T: "fact", C: "claim", R: "resource", A: "artifact", V: "review", Q: "message", E: "evidence",
};
/** Events per page on the collaboration view, for deep links into its audit section. */
const EVENT_PAGE = 100;
const TITLE_MAX = 160;
export const LIFECYCLE_ATTEMPT = "lifecycle";

/** The collaboration page, on the right event page, with that event's audit entry expanded. */
export function eventHref(runId: string, seq: number): string {
  const page = Math.floor((seq - 1) / EVENT_PAGE) * EVENT_PAGE;
  const params = new URLSearchParams();
  if (page > 0) params.set("from", String(page));
  params.set("expanded", detailKey(`event:${runId}:E${seq}`));
  return `/runs/${encodeURIComponent(runId)}/collaboration?${params}#E${seq}`;
}

/** The dashboard page that shows an entity, or undefined for ids the dashboard has no anchor for. */
export function entityHref(runId: string, id: string): string | undefined {
  const match = ENTITY_RE.exec(id);
  if (!match) return undefined;
  const letter = match[1] ?? "";
  const number = match[2] ?? "";
  const run = encodeURIComponent(runId);
  switch (letter) {
    case "I": return `/ideas#idea-${number}`;
    case "F": return `/findings?run=${run}#F${number}`;
    case "T": return `/facts?run=${run}#T${number}`;
    case "C": return `/claims#C${number}`;
    case "R": return `/resources#R${number}`;
    case "A": case "V": case "Q": return `/runs/${run}/collaboration#${id}`;
    case "E": return eventHref(runId, Number(number));
    default: return undefined;
  }
}

function record(value: unknown): Payload {
  return value !== null && typeof value === "object" ? (value as Payload) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function timeOf(draft: Draft, event: HordeEvent): number {
  const at = Date.parse(event.at);
  return Number.isFinite(at) ? at : draft.start;
}

/** Lifecycle events about a member sit in that member's lane; everything else in the actor's. */
function laneOf(event: HordeEvent): string {
  const member = str(event.payload.member);
  return member && event.action.startsWith("member-") ? member : event.actor;
}

function describe(input: Payload, result: Payload): string {
  return oneLine(str(result.text) ?? str(input.text) ?? "", TITLE_MAX);
}

function addMarker(draft: Draft, event: HordeEvent, label: string, title: string): string {
  const id = event.eventId;
  draft.nodes.set(id, {
    id,
    kind: event.attempt === LIFECYCLE_ATTEMPT ? "lifecycle" : "action",
    action: event.action,
    label,
    title: `${id} ${title}`.trim(),
    lane: laneOf(event),
    at: timeOf(draft, event),
    eventId: id,
    href: eventHref(draft.runId, event.seq),
    outcome: event.outcome === "rejected" ? "rejected" : event.outcome === "noop" ? "noop" : "applied",
    marker: true,
    placeholder: false,
  });
  return id;
}

/** False when the id already exists: the event re-touched an entity rather than creating one. */
function addEntity(draft: Draft, event: HordeEvent, node: Pick<GraphNode, "id" | "kind" | "label" | "title">): boolean {
  if (draft.nodes.has(node.id)) return false;
  draft.nodes.set(node.id, {
    ...node,
    action: event.action,
    lane: event.actor,
    at: timeOf(draft, event),
    eventId: event.eventId,
    href: entityHref(draft.runId, node.id) ?? eventHref(draft.runId, event.seq),
    outcome: "applied",
    marker: false,
    placeholder: false,
  });
  return true;
}

/** Targets created before this run get a dashed box at the run start in the parent lane. */
function ensureTarget(draft: Draft, id: string): boolean {
  if (draft.nodes.has(id)) return true;
  const match = ENTITY_RE.exec(id);
  const letter = match?.[1] ?? "";
  const kind = ENTITY_KINDS[letter];
  if (!kind || letter === "E") return false;
  draft.nodes.set(id, {
    id, kind, action: "prior", label: id,
    title: `${id}: created before this run or seeded by its plan`,
    lane: "parent", at: draft.start, eventId: "", href: entityHref(draft.runId, id) ?? "",
    outcome: "applied", marker: false, placeholder: true,
  });
  return true;
}

function addEdge(draft: Draft, from: string, to: string | undefined, label: string, tone: EdgeTone): void {
  if (!to || !ensureTarget(draft, to)) return;
  draft.edges.push({ from, to, label, tone });
}

// ---------------------------------------------------------------------------
// Ledger actions: ideas, findings, facts, claims, resources, verification, solved
// ---------------------------------------------------------------------------

function ideaRef(letter: string, id: number): string {
  return letter === "I" ? `#${id}` : `${letter}${id}`;
}

/** The member's own text, with a finding's importance, support, and concern appended. */
function ownTitle(input: Payload, result: Payload): string {
  const text = oneLine(str(input.text) ?? "", TITLE_MAX) || describe(input, result);
  const meta = [input.importance, input.support, input.concern].filter((value) => typeof value === "string" && value);
  return meta.length > 0 ? `${text} [${meta.join(", ")}]` : text;
}

/** An action that creates `<letter><id>`; a repeat (duplicate, reuse) becomes a marker pointing at it. */
function creates(letter: string, kind: GraphNodeKind, repeat: string, links: (draft: Draft, id: string, input: Payload) => void): Handler {
  return (draft, event, input, result) => {
    const id = num(result.id);
    if (id === undefined) {
      addMarker(draft, event, event.action, describe(input, result));
      return;
    }
    const nodeId = `${letter}${id}`;
    if (addEntity(draft, event, { id: nodeId, kind, label: nodeId, title: ownTitle(input, result) })) {
      links(draft, nodeId, input);
      return;
    }
    addEdge(draft, addMarker(draft, event, `${event.action} (${repeat})`, describe(input, result)), nodeId, repeat, "structure");
  };
}

/** An action on an existing `<letter><input.id>`. */
function actsOn(letter: string, label: string, tone: EdgeTone): Handler {
  return (draft, event, input, result) => {
    const id = num(input.id);
    const ref = id === undefined ? "" : ` ${ideaRef(letter, id)}`;
    const marker = addMarker(draft, event, `${event.action}${ref}`, describe(input, result));
    if (id !== undefined) addEdge(draft, marker, `${letter}${id}`, label, tone);
  };
}

function noLinks(): void {}

function findingLinks(draft: Draft, id: string, input: Payload): void {
  const idea = num(input.idea);
  if (idea !== undefined) addEdge(draft, id, `I${idea}`, "under", "structure");
  const delta = num(input.deltaOf);
  if (delta !== undefined) addEdge(draft, id, `F${delta}`, "delta of", "structure");
  const supersedes = num(input.supersedes);
  if (supersedes !== undefined) addEdge(draft, id, `F${supersedes}`, "supersedes", "negative");
}

function factLinks(draft: Draft, id: string, input: Payload): void {
  const delta = num(input.deltaOf);
  if (delta !== undefined) addEdge(draft, id, `T${delta}`, "delta of", "structure");
}

function solvedHandler(label: string, tone: EdgeTone): Handler {
  return (draft, event, input, result) => {
    const marker = addMarker(draft, event, event.action, describe(input, result));
    if (event.action === "solved") {
      draft.lastSolved = marker;
      return;
    }
    if (draft.lastSolved) draft.edges.push({ from: marker, to: draft.lastSolved, label, tone });
  };
}

const LEDGER: Record<string, Handler> = {
  post: (draft, event, input, result) => { addMarker(draft, event, "post", describe(input, result)); },
  idea: creates("I", "idea", "duplicate", noLinks),
  claim: actsOn("I", "claims", "structure"),
  done: actsOn("I", "done", "structure"),
  drop: actsOn("I", "drops", "negative"),
  "rule-out": actsOn("I", "rules out", "structure"),
  finding: creates("F", "finding", "duplicate", findingLinks),
  fact: creates("T", "fact", "duplicate", factLinks),
  resource: creates("R", "resource", "reuses", noLinks),
  assert: creates("C", "claim", "duplicate", noLinks),
  confirm: actsOn("C", "confirms", "verification"),
  contest: actsOn("C", "contests", "negative"),
  retract: actsOn("C", "retracts", "negative"),
  supersede: actsOn("C", "supersedes", "structure"),
  verify: (draft, event, input, result) => {
    const id = num(input.id);
    const support = str(input.support);
    const label = id === undefined ? "verify" : `verify F${id}${support ? ` [${support}]` : ""}`;
    const marker = addMarker(draft, event, label, describe(input, result));
    if (id !== undefined) addEdge(draft, marker, `F${id}`, "verifies", "verification");
  },
  solved: solvedHandler("proposes", "verification"),
  "confirm-solved": solvedHandler("confirms", "verification"),
  "contest-solved": solvedHandler("contests", "negative"),
};

// ---------------------------------------------------------------------------
// Collaboration records: messages, deliveries, transitions, evidence, reviews, artifacts
// ---------------------------------------------------------------------------

function relationTone(relation: string): EdgeTone {
  if (relation === "supports") return "verification";
  if (relation === "contradicts" || relation === "refutes" || relation === "partially-supports" || relation === "broken") return "negative";
  if (relation === "ready") return "verification";
  return "collaboration";
}

function addMessages(draft: Draft, event: HordeEvent, messages: Payload[]): void {
  for (const message of messages) {
    const id = str(message.id);
    if (!id) continue;
    const kind = str(message.kind) ?? "message";
    const to = str(message.to) ?? "?";
    const title = `to ${to}: ${oneLine(str(message.text) ?? "", TITLE_MAX)}`;
    if (!addEntity(draft, event, { id, kind: "message", label: `${id} ${kind}`, title })) continue;
    addEdge(draft, id, str(message.target), kind, message.blocking === true ? "negative" : "collaboration");
  }
}

/** Messages a record carried alongside its main payload: an automatic challenge or fan-out notices. */
function notifications(event: HordeEvent): Payload[] {
  const list = event.payload.notifications;
  const carried = Array.isArray(list) ? list.map(record) : [];
  return event.payload.message ? [record(event.payload.message), ...carried] : carried;
}

function addEvidence(draft: Draft, event: HordeEvent, evidence: Payload): void {
  const id = str(evidence.id);
  if (!id) return;
  const relation = str(evidence.relation) ?? "evidence";
  const title = oneLine(str(evidence.text) ?? "", TITLE_MAX);
  if (!addEntity(draft, event, { id, kind: "evidence", label: `${id} ${relation}`, title })) return;
  addEdge(draft, id, str(evidence.target), relation, relationTone(relation));
}

function addReview(draft: Draft, event: HordeEvent, review: Payload): void {
  const id = str(review.id);
  if (!id) return;
  const verdict = str(review.verdict) ?? "review";
  const support = str(review.support) ?? "";
  const scope = `checked: ${str(review.checked) ?? ""}; unchecked: ${str(review.unchecked) || "none declared"}`;
  const title = oneLine(`[${support}] ${scope}. ${str(review.text) ?? ""}`, TITLE_MAX);
  if (!addEntity(draft, event, { id, kind: "review", label: `${id} ${verdict}`, title })) return;
  addEdge(draft, id, str(review.target), verdict, relationTone(verdict));
  for (const ref of strings(review.evidence)) {
    if (draft.nodes.has(ref)) draft.edges.push({ from: ref, to: id, label: "cited", tone: "collaboration" });
  }
}

function addArtifact(draft: Draft, event: HordeEvent): void {
  const artifact = record(event.payload.artifact);
  const id = str(artifact.id);
  if (!id) return;
  const hash = str(artifact.hash) ?? "";
  const title = `${str(artifact.path) ?? ""} @${hash.slice(0, 12)} (${str(artifact.kind) ?? "runnable"}): ${oneLine(str(artifact.criteria) ?? "", 100)}`;
  if (!addEntity(draft, event, { id, kind: "artifact", label: id, title })) {
    addEdge(draft, addMarker(draft, event, `republish ${id}`, title), id, "revises", "structure");
    return;
  }
  const dependencies = Array.isArray(artifact.dependencies) ? artifact.dependencies.map(record) : [];
  for (const dependency of dependencies) addEdge(draft, id, str(dependency.target), "depends on", "structure");
}

function transition(label: string, tone: EdgeTone = "collaboration"): Handler {
  return (draft, event) => {
    const t = record(event.payload.transition);
    const id = str(t.id);
    const marker = addMarker(draft, event, `${event.action}${id ? ` ${id}` : ""}`, oneLine(str(t.text) ?? "", TITLE_MAX));
    if (id) addEdge(draft, marker, id, label, tone);
  };
}

const COLLABORATION: Record<string, Handler> = {
  message: (draft, event) => addMessages(draft, event, [record(event.payload.message)]),
  "inbox-delivered": (draft, event) => {
    const id = str(record(event.payload.transition).id);
    const marker = addMarker(draft, event, "inbox", `delivered ${id ?? ""}`);
    if (id && draft.nodes.has(id)) draft.edges.push({ from: id, to: marker, label: "delivered", tone: "collaboration" });
  },
  ack: transition("acknowledges"),
  respond: transition("responds"),
  resolve: transition("resolves"),
  defer: transition("defers", "negative"),
  attach: (draft, event) => addEvidence(draft, event, record(event.payload.evidenceRecord)),
  review: (draft, event) => {
    if (event.payload.evidenceRecord) addEvidence(draft, event, record(event.payload.evidenceRecord));
    addReview(draft, event, record(event.payload.review));
    addMessages(draft, event, notifications(event));
  },
  artifact: (draft, event) => addArtifact(draft, event),
  "resource-state": (draft, event) => {
    const contract = record(event.payload.contract);
    const target = str(contract.target);
    const state = str(contract.state) ?? "state";
    const marker = addMarker(draft, event, `${target ?? "resource"} ${state}`, oneLine(str(contract.health) ?? "", TITLE_MAX));
    addEdge(draft, marker, target, state, relationTone(state));
    addMessages(draft, event, notifications(event));
  },
};

// ---------------------------------------------------------------------------
// Parent lifecycle: run and phase boundaries, member spawn/exit/reset, stops, solved, acceptance
// ---------------------------------------------------------------------------

function lifecycleText(action: string, p: Payload): [string, string] {
  const members = strings(p.members).join(", ");
  switch (action) {
    case "run-start": return ["run start", `${num(p.count) ?? "?"} members${str(p.model) ? `, model ${str(p.model)}` : ""}`];
    case "run-end": return ["run end", `outcome ${str(p.outcome) ?? "unknown"}`];
    case "member-spawn": return ["spawn", str(p.role) ? `role: ${oneLine(str(p.role) ?? "", 120)}` : "spawned"];
    case "member-exit": return [`exit ${str(p.endCause) ?? ""}`.trim(), `status ${str(p.status) ?? "?"}, ${num(p.turns) ?? 0} turns, ${num(p.tokens) ?? 0} tokens`];
    case "member-reset": return ["reset", `${str(p.reason) ?? ""}; released ${strings(p.released).length}, closed ${strings(p.closed).length}`];
    case "stop-clean": return [`stop-clean (${str(p.label) ?? "stop-clean"})`, members || "all members"];
    case "stop-hard": return [`stop-hard (${str(p.by) ?? "user"})`, members || "all members"];
    case "solved-proposed": return ["solved proposed", `${str(p.member) ?? ""}: ${oneLine(str(p.text) ?? "", 120)}`];
    case "solved-contested": return ["solved contested", `by ${str(p.member) ?? ""}`];
    case "solved-validated": return ["solved validated", str(p.validator) ? `by ${str(p.validator)}` : "without a separate validator"];
    case "acceptance": return [`acceptance ${str(p.status) ?? ""}`.trim(), `${num(p.issues) ?? 0} issues, snapshot ${(str(p.hash) ?? "").slice(0, 12)}`];
    case "repair-start": return ["repair start", `queue ${strings(p.messages).join(", ")}`];
    case "repair-end": return ["repair end", `${str(p.cause) ?? ""}${str(p.stopReason) ? ` (${str(p.stopReason)})` : ""}`];
    case "repair-skipped": return ["repair skipped", str(p.reason) ?? ""];
    default: return [action, oneLine(JSON.stringify(p), TITLE_MAX)];
  }
}

function setPhase(draft: Draft, event: HordeEvent, key: "from" | "to"): void {
  const phase = str(event.payload.phase);
  if (!phase) return;
  draft.phases.set(phase, { ...draft.phases.get(phase), [key]: timeOf(draft, event) });
}

const LIFECYCLE: Record<string, Handler> = {
  "phase-start": (draft, event) => setPhase(draft, event, "from"),
  "phase-end": (draft, event) => setPhase(draft, event, "to"),
  "run-start": (draft, event) => {
    strings(event.payload.roles).forEach((role, index) => { if (role) draft.roles.set(`member-${index + 1}`, role); });
    draft.verifier = str(event.payload.verifier);
    const [label, title] = lifecycleText(event.action, event.payload);
    addMarker(draft, event, label, title);
  },
  "run-end": (draft, event) => {
    draft.runEnd = timeOf(draft, event);
    const [label, title] = lifecycleText(event.action, event.payload);
    addMarker(draft, event, label, title);
  },
};

/** Everything not handled above, including unknown actions, becomes a marker in the actor's lane. */
function addGeneric(draft: Draft, event: HordeEvent): void {
  const [label, title] = lifecycleText(event.action, event.payload);
  addMarker(draft, event, label, title);
}

function refusedTarget(action: string, input: Payload): string | undefined {
  const id = num(input.id);
  if (["claim", "done", "drop", "rule-out"].includes(action) && id !== undefined) return `I${id}`;
  if (action === "finding") {
    const idea = num(input.idea);
    return idea === undefined ? undefined : `I${idea}`;
  }
  if (action === "verify" && id !== undefined) return `F${id}`;
  if (["confirm", "contest", "retract", "supersede"].includes(action) && id !== undefined) return `C${id}`;
  return str(input.target);
}

/** Rejected and clean-stop refusals stay visible: they are where runs go wrong. */
function addRefused(draft: Draft, event: HordeEvent): void {
  const input = record(event.payload.input);
  const title = event.outcome === "rejected"
    ? oneLine(str(event.payload.error) ?? "rejected", TITLE_MAX)
    : "refused: new work during clean stop";
  const marker = addMarker(draft, event, `${event.action} (${event.outcome})`, title);
  addEdge(draft, marker, refusedTarget(event.action, input), event.action, "negative");
}

function addEvent(draft: Draft, event: HordeEvent): void {
  if (event.outcome !== "applied") {
    addRefused(draft, event);
    return;
  }
  const handler = LEDGER[event.action] ?? COLLABORATION[event.action] ?? LIFECYCLE[event.action];
  if (handler) handler(draft, event, record(event.payload.input), record(event.payload.result));
  else addGeneric(draft, event);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function startOf(input: RunGraphInput, events: HordeEvent[]): number {
  const runStart = events.find((e) => e.action === "run-start" && e.attempt === LIFECYCLE_ATTEMPT);
  const first = events[0];
  const candidates = [runStart ? Date.parse(runStart.at) : undefined, input.startedAt, first ? Date.parse(first.at) : undefined]
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (runStart && candidates[0] !== undefined) return candidates[0];
  return candidates.length > 0 ? Math.min(...candidates) : Date.now();
}

function laneRank(id: string): [number, number, string] {
  if (id === "parent") return [0, 0, id];
  const member = /^member-(\d+)$/.exec(id);
  return member ? [1, Number(member[1]), id] : [2, 0, id];
}

function lanesOf(draft: Draft, nodes: GraphNode[], members: GraphMember[]): GraphLane[] {
  const ids = new Set<string>(["parent", ...members.map((m) => m.name), ...nodes.map((n) => n.lane)]);
  const status = new Map(members.map((m) => [m.name, m.status]));
  return [...ids]
    .sort((a, b) => {
      const [ga, na, sa] = laneRank(a);
      const [gb, nb, sb] = laneRank(b);
      return ga - gb || na - nb || sa.localeCompare(sb);
    })
    .map((id) => ({
      id,
      label: id === draft.verifier ? `${id} (verifier)` : id,
      href: id === "parent" ? undefined : `/runs/${encodeURIComponent(draft.runId)}/members/${encodeURIComponent(id)}`,
      role: id === draft.verifier ? "verifier" : draft.roles.get(id),
      status: status.get(id),
    }));
}

/** Recorded phase boundaries when the parent wrote them; otherwise discovery plus any repair span. */
function phasesOf(draft: Draft, nodes: GraphNode[], start: number, end: number): GraphPhase[] {
  const recorded: GraphPhase[] = [];
  for (const [id, span] of draft.phases) {
    if (span.from !== undefined) recorded.push({ id, from: span.from, to: span.to ?? end });
  }
  if (recorded.length > 0) return recorded.sort((a, b) => a.from - b.from);
  const starts = nodes.filter((n) => n.action === "repair-start").map((n) => n.at);
  const ends = nodes.filter((n) => n.action === "repair-end").map((n) => n.at);
  const repairFrom = starts.length > 0 ? Math.min(...starts) : undefined;
  const phases: GraphPhase[] = [{ id: "discovery", from: start, to: repairFrom ?? end }];
  if (repairFrom !== undefined) phases.push({ id: "repair", from: repairFrom, to: ends.length > 0 ? Math.max(...ends) : end });
  return phases;
}

/** Project a run's events (plus what the parent knows about its members) into lanes, phases, nodes, and edges. */
export function buildRunGraph(input: RunGraphInput): RunGraph {
  const events = input.events.filter((event) => event.outcome !== "intent");
  const start = startOf(input, events);
  const draft: Draft = { runId: input.runId, start, nodes: new Map(), edges: [], phases: new Map(), roles: new Map() };
  for (const event of events) addEvent(draft, event);
  const nodes = [...draft.nodes.values()].sort((a, b) => a.at - b.at);
  const last = events.at(-1);
  const lastAt = last ? Date.parse(last.at) : start;
  const observed = Math.max(draft.runEnd ?? 0, Number.isFinite(lastAt) ? lastAt : start, input.now ?? 0);
  // A run with no duration yet still needs a time axis to draw against.
  const end = observed > start ? observed : start + 1_000;
  const members = input.members ?? [];
  return {
    runId: input.runId,
    start,
    end,
    lanes: lanesOf(draft, nodes, members),
    phases: phasesOf(draft, nodes, start, end),
    nodes,
    edges: draft.edges,
  };
}
