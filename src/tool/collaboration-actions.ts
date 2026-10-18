import * as fs from "node:fs";
import * as path from "node:path";
import { listFindingsForRun } from "../ledger/findings.js";
import { requireParam, requireText } from "../ledger/files.js";
import { collaborationState, openMessages, projectCollaboration } from "../ledger/collaboration.js";
import type { CollaborationState, PeerMessage } from "../ledger/collaboration.js";
import { transactEvent } from "../ledger/events.js";
import type { EventContext, EventDraft } from "../ledger/events.js";
import { currentTarget, targetInfo, retainArtifact, hashText } from "./collaboration-target.js";
import { collaborationView, inspectRecord } from "./collaboration-view.js";
import { resourceTransition } from "./resource-contract.js";
import type { HordeToolParams } from "./params.js";

export const COLLABORATION_ACTIONS = new Set(["inbox", "message", "ack", "respond", "resolve", "defer", "attach", "review", "artifact", "resource-state", "collaboration", "inspect"]);
interface CollaborationCommand {
  ctx: EventContext;
  state: CollaborationState;
  params: HordeToolParams;
  seq: number;
}

function evidenceRefs(state: CollaborationState, refs: string[] = []): string[] {
  for (const id of refs) {
    if (state.evidence.some((e) => e.id === id)) continue;
    const kind = /^[A-Z]\d+$/.test(id) && !id.startsWith("E") ? `; ${id} is not evidence, refs take E# ids (attach evidence first, or name ${id} as the target)` : "";
    throw new Error(`horde: unknown evidence ${id}${kind}`);
  }
  return refs;
}

function newMessage(c: CollaborationCommand): EventDraft {
  const { ctx, state, params: p, seq } = c;
  const target = requireParam(p.target, "target", p.action);
  const info = targetInfo(ctx, state, target);
  const to = p.to ?? info.owner;
  const task = path.join(ctx.hordeDir, "runs", ctx.runId, "TASK.md");
  const count = fs.existsSync(task) ? Number(/^Members: (\d+)/m.exec(fs.readFileSync(task, "utf8"))?.[1]) : 0;
  if (!/^member-[1-9]\d*$/.test(to) || (count && Number(to.slice(7)) > count)) throw new Error("horde: recipient must be a member of this run");
  if (p.revision && p.revision !== info.revision) throw new Error("horde: target changed; inspect current revision");
  const message: PeerMessage = {
    id: `Q${seq}`, sender: ctx.actor, to, target, revision: info.revision, kind: p.kind ?? "question",
    text: requireText(p.text, "message"), blocking: p.blocking ?? ["challenge", "blocker"].includes(p.kind ?? ""),
    evidence: evidenceRefs(state, p.refs), state: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deliveries: {},
  };
  return { payload: { message }, parents: message.evidence };
}

function transition(c: CollaborationCommand): EventDraft {
  const { ctx, state, params: p } = c;
  const m = state.messages.find((entry) => entry.id === p.target);
  if (!m) throw new Error("horde: unknown message Q#");
  if (m.state === "resolved") throw new Error("horde: message is already closed; create a new request");
  // A deferred request is disclosed debt, not a closed thread: the recipient may still answer it
  // and the sender may still resolve it. Otherwise a blocking challenge deferred before any
  // response could never be cleared by anyone.
  if (m.state === "deferred" && p.action !== "resolve" && p.action !== "respond") throw new Error("horde: a deferred request takes a response from its recipient or a resolution from its sender");
  const closing = p.action === "resolve" || p.action === "defer";
  if (closing ? ctx.actor !== m.sender : ctx.actor !== m.to) throw new Error("horde: recipient acknowledges/responds; sender resolves/defers after review");
  if (p.action === "respond" && !["acknowledged", "responded", "deferred"].includes(m.state)) throw new Error("horde: acknowledge the request before responding");
  const text = requireText(p.text, p.action);
  const refs = evidenceRefs(state, p.refs);
  if (p.action === "resolve" && m.blocking) validateResolution(c, m, refs);
  if (p.action !== "ack" && p.action !== "respond" && p.action !== "resolve" && p.action !== "defer") throw new Error("horde: invalid message transition");
  const status = { ack: "acknowledged", respond: "responded", resolve: "resolved", defer: "deferred" }[p.action];
  const responseTarget = p.action === "respond" || p.action === "resolve" ? responseSubject(c, m) : undefined;
  if (p.action === "respond") {
    const revision = targetInfo(ctx, state, responseTarget!).revision;
    if (p.revision !== revision) throw new Error(`horde: respond requires ${responseTarget}@${revision}; use responseTarget for a related correction, not another target's hash`);
  }
  return { payload: { transition: { id: m.id, state: status, text, revision: p.revision, responseTarget }, refs }, parents: [m.id, ...refs] };
}

function responseSubject(c: CollaborationCommand, m: PeerMessage): string {
  const target = c.params.responseTarget ?? m.responseTarget ?? currentTarget(c.ctx, m.target);
  if (target === m.target || target === currentTarget(c.ctx, m.target)) return currentTarget(c.ctx, target);
  const finding = listFindingsForRun(c.ctx.hordeDir, c.ctx.runId).find((f) => `F${f.id}` === target);
  if (/^I\d+$/.test(m.target) && finding?.ideaId === Number(m.target.slice(1))) return currentTarget(c.ctx, target);
  throw new Error("horde: responseTarget must be the challenged target, its successor, or a finding attached to the challenged idea");
}

function validateResolution(c: CollaborationCommand, m: PeerMessage, refs: string[]): void {
  if (!["responded", "deferred"].includes(m.state) || !m.responseRevision || refs.length === 0) throw new Error("horde: blocking resolution needs a response and evidence");
  if (m.sender === m.to) throw new Error("horde: a blocking request needs an independent resolver");
  const target = responseSubject(c, m);
  const revision = targetInfo(c.ctx, c.state, target).revision;
  if ((c.params.revision ?? m.responseRevision) !== revision) throw new Error(`horde: response is stale; explicitly review and resolve ${target}@${revision}, or ask the owner to respond again`);
  if (!refs.some((id) => c.state.evidence.some((e) => e.id === id && e.target === target && e.revision === revision))) throw new Error("horde: resolution evidence must address the current response target revision");
  if (target.startsWith("A") || target.startsWith("F")) {
    const review = c.state.reviews.findLast((r) => r.target === target && r.revision === revision && r.actor === c.ctx.actor);
    if (!review || review.verdict !== "supports" || (target.startsWith("A") && review.unchecked)) throw new Error("horde: resolve requires your supporting review of the current revision; finding limitations remain acceptance debt");
  }
}

function attachEvidence(c: CollaborationCommand): EventDraft {
  const { ctx, state, params: p, seq } = c;
  const target = requireParam(p.target, "target", p.action);
  const info = targetInfo(ctx, state, target);
  if (p.revision && p.revision !== info.revision) throw new Error("horde: target revision changed");
  const file = p.artifactPath ? retainArtifact(ctx, p.artifactPath) : {};
  const text = requireText(p.text, "attach");
  return { payload: { evidenceRecord: { id: `E${seq}`, actor: ctx.actor, target, revision: info.revision,
    relation: p.relation ?? "extends", text, ...file },
    ...(p.relation === "contradicts" ? automaticChallenge(c, target, info, text, [`E${seq}`]) : {}) } };
}

function publishArtifact(c: CollaborationCommand): EventDraft {
  const { ctx, state, params: p, seq } = c;
  const existing = p.target ? state.artifacts.find((a) => a.id === p.target) : undefined;
  if (p.target && !existing) throw new Error("horde: unknown artifact A#");
  if (existing && existing.owner !== ctx.actor) throw new Error("horde: only the artifact owner may publish its revision; request a repair");
  if (existing && p.revision !== existing.hash) throw new Error("horde: publish requires the previous revision hash");
  const retained = retainArtifact(ctx, requireParam(p.artifactPath, "artifactPath", p.action));
  const kind = p.artifactKind ?? existing?.kind ?? "runnable";
  if (existing && kind !== (existing.kind ?? "runnable")) throw new Error("horde: artifact kind is immutable; publish a distinct artifact for a different acceptance contract");
  if (kind === "document" && !/\.(?:md|markdown|txt|rst|adoc|pdf)$/i.test(retained.path)) {
    throw new Error("horde: document artifacts require a document extension (.md, .txt, .rst, .adoc, .pdf); executable outputs require artifactKind=runnable");
  }
  const criteria = requireParam(p.criteria, "criteria", p.action);
  const dependencies = (p.dependsOn ?? []).map((target) => ({ target, revision: targetInfo(ctx, state, target).revision }));
  if (dependencies.some((d) => d.target === p.target)) throw new Error("horde: artifact cannot depend on itself");
  if (existing && existing.hash === retained.hash && (existing.criteria !== criteria || JSON.stringify(existing.dependencies) !== JSON.stringify(dependencies))) {
    throw new Error("horde: changing criteria or dependencies requires a new file revision so prior reviews cannot transfer to a different contract");
  }
  return { payload: { artifact: { id: existing?.id ?? `A${seq}`, kind, owner: ctx.actor, ...retained,
    criteria, dependencies } }, parents: evidenceRefs(state, p.refs) };
}

function recordReview(c: CollaborationCommand): EventDraft {
  const { ctx, state, params: p, seq } = c;
  const target = requireParam(p.target, "target", p.action);
  const info = targetInfo(ctx, state, target);
  if (!/^[FA]\d+$/.test(target)) throw new Error("horde: review targets an F# or A#");
  if (info.owner === ctx.actor) throw new Error("horde: an independent review needs another member");
  if (p.revision !== info.revision) throw new Error("horde: review must name the current revision from inspect");
  if (!["reproduced", "tested", "derived", "sourced"].includes(p.support ?? "")) throw new Error("horde: review needs non-speculative support");
  const refs = [...evidenceRefs(state, p.refs)];
  if (!refs.length && !p.evidenceText) throw new Error("horde: attach evidence before reviewing or supply evidenceText for an atomic evidence+review");
  if (!p.verdict || p.unchecked === undefined) throw new Error("horde: review needs verdict and unchecked (empty only for full coverage)");
  if (refs.some((id) => !state.evidence.some((e) => e.id === id && e.target === target && e.revision === info.revision))) throw new Error("horde: review evidence must address this exact target revision");
  const text = requireText(p.text, "review");
  const checked = requireParam(p.checked, "checked", p.action);
  const evidenceRecord = p.evidenceText === undefined ? undefined : {
    id: `E${seq}`, actor: ctx.actor, target, revision: info.revision,
    relation: p.verdict === "refutes" ? "contradicts" : p.verdict === "supports" ? "supports" : "extends",
    text: requireParam(p.evidenceText, "evidenceText", p.action), ...(p.artifactPath ? retainArtifact(ctx, p.artifactPath) : {}),
  };
  if (evidenceRecord) refs.push(evidenceRecord.id);
  return { payload: { ...(evidenceRecord ? { evidenceRecord } : {}), review: { id: `V${seq}`, actor: ctx.actor, target, revision: info.revision,
    verdict: p.verdict, support: p.support, checked, unchecked: p.unchecked,
    text, evidence: refs },
    ...completeAssignedReview(c, target, text),
    ...(["refutes", "partially-supports"].includes(p.verdict) ? automaticChallenge(c, target, info, text, refs) : {}) }, parents: refs.filter((id) => id !== evidenceRecord?.id) };
}

function completeAssignedReview(c: CollaborationCommand, target: string, text: string): Record<string, unknown> {
  const assignment = openMessages(c.state).find((m) => m.sender === "parent" && m.to === c.ctx.actor && m.kind === "review-request" && m.target === target);
  return assignment ? { transition: { id: assignment.id, state: "resolved", text: `Review recorded: ${text}`, revision: c.params.revision } } : {};
}

function automaticChallenge(c: CollaborationCommand, target: string, info: { owner: string; revision: string }, text: string, refs: string[]): Record<string, unknown> {
  if (c.ctx.actor === info.owner || openMessages(c.state).some((m) => m.target === target && m.revision === info.revision && m.blocking)) return {};
  return { message: { id: `Q${c.seq}`, sender: c.ctx.actor, to: info.owner, kind: "challenge", target,
    revision: info.revision, text, blocking: true, evidence: refs, state: "pending",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deliveries: {} } };
}

function decide(c: CollaborationCommand): EventDraft {
  switch (c.params.action) {
    case "message": return newMessage(c);
    case "attach": return attachEvidence(c);
    case "review": return recordReview(c);
    case "artifact": return publishArtifact(c);
    case "resource-state": return resourceTransition(c);
    default: return transition(c);
  }
}

/** IDEAS.md shows ideas as `#22`; members copy that or write `I#22` where targets expect `I22`. */
function normalizeTargetId(id: string): string {
  const idea = /^I?#(\d+)$/.exec(id.trim());
  return idea ? `I${idea[1]}` : id;
}

function normalizeTargets(params: HordeToolParams): HordeToolParams {
  return {
    ...params,
    ...(params.target === undefined ? {} : { target: normalizeTargetId(params.target) }),
    ...(params.responseTarget === undefined ? {} : { responseTarget: normalizeTargetId(params.responseTarget) }),
    ...(params.dependsOn === undefined ? {} : { dependsOn: params.dependsOn.map(normalizeTargetId) }),
  };
}

export async function runCollaborationAction(ctx: EventContext, rawParams: HordeToolParams): Promise<{ text: string }> {
  const params = normalizeTargets(rawParams);
  ctx = { ...ctx, requestId: params.requestId ?? ctx.requestId };
  if (["inbox", "collaboration", "inspect"].includes(params.action)) {
    const state = collaborationState(ctx.hordeDir, ctx.runId);
    const message = state.messages.find((m) => m.id === params.target);
    const target = message ? responseSubject({ ctx, state, params, seq: state.seq }, message) : params.target;
    const value = params.action === "inbox" ? openMessages(state).filter((m) => m.to === ctx.actor || m.sender === ctx.actor)
      : params.action === "inspect" ? { ...inspectRecord(ctx, state, requireParam(target, "target", params.action), params.detail), ...(message ? { message } : {}) } : collaborationView(state, params);
    return { text: JSON.stringify(value) };
  }
  const event = await transactEvent({ ...ctx, inputHash: hashText(JSON.stringify(params)) }, params.action, (events, seq) => {
    try {
      return { ...decide({ ctx, state: projectCollaboration(events), params, seq }) };
    } catch (error) {
      return { outcome: "rejected", payload: { input: params, error: error instanceof Error ? error.message : String(error) } };
    }
  });
  if (event.outcome === "rejected") throw new Error(String(event.payload.error));
  return { text: JSON.stringify({ eventId: event.eventId, ...event.payload }) };
}
