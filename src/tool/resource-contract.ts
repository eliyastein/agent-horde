import { listResources } from "../ledger/resources.js";
import type { CollaborationState, PeerMessage, ResourceContract } from "../ledger/collaboration.js";
import type { EventContext, EventDraft } from "../ledger/events.js";
import { requireParam, requireText } from "../ledger/files.js";
import { targetInfo } from "./collaboration-target.js";
import type { HordeToolParams } from "./params.js";

/** Serialized by transactEvent. A lease coordinates cooperative writers, not shell permissions. */
export function resourceTransition(c: { ctx: EventContext; state: CollaborationState; params: HordeToolParams; seq: number }): EventDraft {
  const { ctx, state, params: p } = c;
  const target = requireParam(p.target, "target", p.action);
  if (!/^R\d+$/.test(target)) throw new Error("horde: resource-state needs R#");
  const info = targetInfo(ctx, state, target);
  const old = state.resources.find((r) => r.target === target);
  const now = Date.now();
  if (old && p.generation !== old.generation) throw new Error("horde: resource generation changed; read collaboration first");
  const sameHolder = old?.owner === ctx.actor && old?.attempt === (ctx.attempt ?? "legacy");
  if (old && !sameHolder && old.leaseUntil > now) throw new Error(`horde: resource leased by ${old.owner} until ${new Date(old.leaseUntil).toISOString()}`);
  if (!old && info.owner !== ctx.actor) throw new Error("horde: resource owner must publish the first contract");
  if (!p.resourceState) throw new Error("horde: resourceState is required");
  const duration = p.leaseSeconds ?? 300;
  if (!Number.isInteger(duration) || duration < 1 || duration > 1800) throw new Error("horde: leaseSeconds must be 1..1800");
  const ports = [...new Set(p.ports ?? old?.ports ?? [])];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("horde: invalid port");
  const collision = state.resources.find((r) => r.target !== target && r.state !== "retired" && r.ports.some((port) => ports.includes(port)));
  // Expiry permits takeover of the same resource, never blind reuse of a potentially live port.
  if (collision) throw new Error(`horde: port reserved by ${collision.target}; retire it after confirming teardown`);
  const refs = p.refs ?? [];
  if (refs.some((id) => !state.evidence.some((e) => e.id === id))) throw new Error("horde: unknown health evidence");
  if (p.resourceState === "ready" && refs.length === 0) throw new Error("horde: ready needs retained health-check evidence");
  const contract: ResourceContract = {
    target, owner: ctx.actor, attempt: ctx.attempt ?? "legacy", state: p.resourceState,
    generation: (old?.generation ?? 0) + 1, ports: p.resourceState === "retired" ? [] : ports,
    leaseUntil: p.resourceState === "retired" ? 0 : now + duration * 1000,
    health: requireText(p.text, p.action), evidence: refs,
  };
  const subscribers = new Set([
    ...state.artifacts.filter((a) => a.dependencies.some((d) => d.target === target)).map((a) => a.owner),
    ...(listResources(ctx.hordeDir).find((r) => `R${r.id}` === target)?.reusers ?? []),
  ]);
  const messages: PeerMessage[] = old?.state === contract.state ? [] : [...subscribers].filter((member) => member !== ctx.actor).map((member, index) => ({
    id: `Q${c.seq}-${index + 1}`, sender: ctx.actor, to: member, kind: "handoff", target,
    revision: `generation-${contract.generation}`, text: `${target} is ${contract.state}, generation ${contract.generation}. Health: ${contract.health}. Inspect before using; refresh dependent artifacts if needed.`,
    blocking: false, evidence: refs, state: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deliveries: {},
  }));
  return { payload: { contract, notifications: messages }, parents: refs };
}
