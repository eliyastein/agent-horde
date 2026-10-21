import { readEvents } from "./events.js";
import type { HordeEvent } from "./events.js";

type MessageKind = "question" | "blocker" | "review-request" | "challenge" | "handoff" | "decision";
type MessageState = "pending" | "delivered" | "acknowledged" | "responded" | "resolved" | "deferred";
export interface PeerMessage {
  id: string;
  sender: string;
  to: string;
  kind: MessageKind;
  target: string;
  revision: string;
  text: string;
  blocking: boolean;
  evidence: string[];
  state: MessageState;
  createdAt: string;
  updatedAt: string;
  response?: string;
  responseRevision?: string;
  responseTarget?: string;
  /** Evidence the recipient attached to its response. */
  responseEvidence?: string[];
  resolution?: string;
  /** Evidence the sender attached when resolving or deferring. */
  resolutionEvidence?: string[];
  deliveries: Record<string, string>;
}
interface EvidenceRecord {
  id: string;
  actor: string;
  target: string;
  revision: string;
  text: string;
  relation: "supports" | "contradicts" | "extends";
  path?: string;
  hash?: string;
}
export interface ArtifactRecord {
  id: string;
  /** Missing in historical events means runnable: preserve the stricter acceptance rule. */
  kind?: "runnable" | "document";
  owner: string;
  path: string;
  hash: string;
  snapshot: string;
  criteria: string;
  dependencies: Array<{ target: string; revision: string }>;
  /** The owner's statement of what a republish changed, required once other artifacts pin it. */
  changeNote?: string;
  /** Projected from the publishing event; absent in hand-built records. */
  publishedAt?: string;
}
export interface ReviewRecord {
  id: string;
  actor: string;
  target: string;
  revision: string;
  verdict: "supports" | "partially-supports" | "refutes" | "inconclusive";
  support: string;
  checked: string;
  /** Gaps inside the target's stated claim or criteria; non-empty keeps acceptance open. */
  unchecked: string;
  /** Disclosures outside the criteria; recorded on the acceptance as limits, never blockers. */
  limits?: string;
  text: string;
  evidence: string[];
  /** The reviewer's earlier review of a previous revision that this one carries forward. */
  reattests?: string;
}
export interface ResourceContract {
  target: string;
  owner: string;
  attempt: string;
  state: "building" | "ready" | "broken" | "retired";
  generation: number;
  ports: number[];
  leaseUntil: number;
  health: string;
  evidence: string[];
}
export interface CollaborationState {
  seq: number;
  messages: PeerMessage[];
  evidence: EvidenceRecord[];
  artifacts: ArtifactRecord[];
  reviews: ReviewRecord[];
  resources: ResourceContract[];
}

/** Pure projection. Retains all evidence/reviews; artifacts expose their latest revision. */
export function projectCollaboration(events: HordeEvent[]): CollaborationState {
  const state: CollaborationState = { seq: events.at(-1)?.seq ?? 0, messages: [], evidence: [], artifacts: [], reviews: [], resources: [] };
  for (const event of events) {
    if (event.outcome !== "applied") continue;
    const p = event.payload;
    if (p.message) state.messages.push(structuredClone(p.message) as unknown as PeerMessage);
    if (Array.isArray(p.notifications)) state.messages.push(...structuredClone(p.notifications) as PeerMessage[]);
    if (p.evidenceRecord) state.evidence.push(p.evidenceRecord as unknown as EvidenceRecord);
    if (p.review) state.reviews.push(p.review as unknown as ReviewRecord);
    if (p.artifact) {
      const artifact = { ...(p.artifact as unknown as ArtifactRecord), publishedAt: event.at };
      state.artifacts = state.artifacts.filter((a) => a.id !== artifact.id).concat(artifact);
    }
    if (p.contract) {
      const contract = p.contract as unknown as ResourceContract;
      state.resources = state.resources.filter((r) => r.target !== contract.target).concat(contract);
    }
    if (p.transition) applyTransition(state, event);
    if (Array.isArray(p.clearances)) applyClearances(state, event);
  }
  return state;
}

/** A full-scope review that covers a partial review's unchecked scope resolves the challenge that review raised. */
function applyClearances(state: CollaborationState, event: HordeEvent): void {
  for (const clearance of event.payload.clearances as Array<{ id: string; text: string; refs: string[] }>) {
    const message = state.messages.find((m) => m.id === clearance.id);
    if (!message || message.state === "resolved") continue;
    message.state = "resolved";
    message.resolution = clearance.text;
    message.resolutionEvidence = clearance.refs;
    message.updatedAt = event.at;
  }
}

function applyTransition(state: CollaborationState, event: HordeEvent): void {
  const t = event.payload.transition as { id: string; state: MessageState; text?: string; revision?: string; responseTarget?: string; attempt?: string };
  const message = state.messages.find((m) => m.id === t.id);
  if (!message) return;
  const refs = Array.isArray(event.payload.refs) ? (event.payload.refs as string[]) : [];
  if (t.state === "delivered") {
    message.deliveries[t.attempt ?? event.attempt] = event.at;
    if (message.state === "pending") message.state = "delivered";
  } else {
    message.state = t.state;
    if (t.state === "responded") {
      message.response = t.text;
      message.responseRevision = t.revision;
      message.responseTarget = t.responseTarget;
      message.responseEvidence = refs;
    } else if (t.state === "resolved" || t.state === "deferred") {
      message.resolution = t.text;
      message.resolutionEvidence = refs;
    }
  }
  message.updatedAt = event.at;
}

export function collaborationState(hordeDir: string, runId: string): CollaborationState {
  return projectCollaboration(readEvents(hordeDir, runId));
}

export function openMessages(state: CollaborationState): PeerMessage[] {
  return state.messages.filter((m) => m.state !== "resolved" && m.state !== "deferred");
}

/** Deferring a blocking challenge discloses debt; it does not accept the affected output. */
export function blockingMessages(state: CollaborationState): PeerMessage[] {
  return state.messages.filter((m) => m.blocking && m.state !== "resolved");
}

/** Each non-owner's latest review of the artifact's current revision. */
export function latestArtifactReviews(state: CollaborationState, artifact: ArtifactRecord): ReviewRecord[] {
  const latest = new Map<string, ReviewRecord>();
  for (const review of state.reviews) {
    if (review.target === artifact.id && review.revision === artifact.hash && review.actor !== artifact.owner) latest.set(review.actor, review);
  }
  return [...latest.values()];
}

function acceptingReview(artifact: ArtifactRecord, review: ReviewRecord): boolean {
  const methods = artifact.kind === "document" ? ["sourced", "derived", "tested", "reproduced"] : ["tested", "reproduced"];
  return review.verdict === "supports" && !review.unchecked && methods.includes(review.support);
}

export function artifactAccepted(state: CollaborationState, artifact: ArtifactRecord): boolean {
  if (blockingMessages(state).some((m) => m.target === artifact.id)) return false;
  const latest = latestArtifactReviews(state, artifact);
  if (latest.some((r) => r.verdict === "refutes")) return false;
  return latest.some((r) => acceptingReview(artifact, r));
}

/** Limits the accepting reviews disclosed outside the criteria, each named with its review. */
export function artifactLimits(state: CollaborationState, artifact: ArtifactRecord): string[] {
  return latestArtifactReviews(state, artifact)
    .filter((r) => acceptingReview(artifact, r) && r.limits?.trim())
    .map((r) => `${r.id} (${r.actor}): ${r.limits?.trim()}`);
}

/** Reviews of the current revision that left in-criteria scope unchecked: coverage debt, named. */
export function partialArtifactReviews(state: CollaborationState, artifact: ArtifactRecord): ReviewRecord[] {
  return latestArtifactReviews(state, artifact).filter((r) => r.verdict !== "refutes" && r.unchecked.trim());
}
