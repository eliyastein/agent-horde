import * as path from "node:path";
import type { CollaborationState } from "../ledger/collaboration.js";
import { readEvents } from "../ledger/events.js";
import type { EventContext } from "../ledger/events.js";
import { listFindingsForRun } from "../ledger/findings.js";
import { listIdeas } from "../ledger/ideas.js";
import { listResources } from "../ledger/resources.js";
import { readSolvedState } from "../ledger/run-signals.js";
import { targetInfo } from "./collaboration-target.js";
import type { HordeToolParams } from "./params.js";

const COLLECTIONS = ["messages", "evidence", "artifacts", "reviews", "resources"] as const;
const PROSE = new Set(["text", "checked", "unchecked", "criteria", "health", "response", "resolution"]);

/** Summaries are navigation aids. Every shortened field has a full-record retrieval path. */
function summary(record: object): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  const shortened: Record<string, number> = {};
  for (const [key, value] of Object.entries(out)) {
    if (PROSE.has(key) && typeof value === "string" && value.length > 160) {
      out[key] = `${value.slice(0, 160)}…`;
      shortened[key] = value.length;
    }
    if (key === "deliveries" && value && typeof value === "object") {
      out.deliveryCount = Object.keys(value).length;
      delete out.deliveries;
    }
  }
  if (Object.keys(shortened).length) out.fullFieldChars = shortened;
  return out;
}

/** Stable per-collection pages. Filtering retains matching messages, evidence and reviews. */
export function collaborationView(state: CollaborationState, params: HordeToolParams): Record<string, unknown> {
  const offset = Math.max(0, Math.floor(params.offset ?? 0));
  const limit = Math.max(1, Math.min(100, Math.floor(params.limit ?? 25)));
  const counts: Record<string, number> = {};
  const next: Record<string, number> = {};
  const out: Record<string, unknown> = { seq: state.seq, offset, limit, counts, next,
    read: "inspect target=ID detail=full returns the complete record. detail=full returns full page bodies. Page each collection with offset/limit; target filters to one subject." };
  for (const collection of COLLECTIONS) {
    const records = state[collection]
      .filter((r) => !params.target || ("id" in r && r.id === params.target) || ("target" in r && r.target === params.target))
      .sort((a, b) => Number(("id" in a ? a.id : a.target).slice(1)) - Number(("id" in b ? b.id : b.target).slice(1)));
    counts[collection] = records.length;
    if (offset + limit < records.length) next[collection] = offset + limit;
    out[collection] = records.slice(offset, offset + limit).map((r) => params.detail === "full" ? r : summary(r));
  }
  return out;
}

/** Exact records remain available even when a finding was superseded or an event was rejected. */
export function inspectRecord(ctx: EventContext, state: CollaborationState, target: string, detail?: string): Record<string, unknown> {
  const review = state.reviews.find((r) => r.id === target);
  if (review) return { target, review };
  if (/^E\d+$/.test(target)) {
    const event = readEvents(ctx.hordeDir, ctx.runId).find((e) => e.eventId === target);
    if (event) return { target, event };
  }
  const finding = listFindingsForRun(ctx.hordeDir, ctx.runId).find((f) => `F${f.id}` === target);
  if (finding?.supersededBy !== undefined) return { target, ...(detail === "full" ? { finding } : {}), supersededBy: `F${finding.supersededBy}`, warning: "Historical finding; reviews must target the current successor." };
  const info = targetInfo(ctx, state, target);
  if (detail !== "full") return { target, ...info, read: "inspect this target with detail=full for its complete record" };
  const artifact = state.artifacts.find((a) => a.id === target);
  const idea = listIdeas(ctx.hordeDir).find((i) => `I${i.id}` === target);
  const resource = listResources(ctx.hordeDir).find((r) => `R${r.id}` === target);
  return { target, ...info, ...(finding ? { finding } : {}), ...(artifact ? { artifact } : {}),
    ...(idea ? { idea } : {}), ...(resource ? { resource, contract: state.resources.find((r) => r.target === target) } : {}),
    ...(target === "answer" ? { proposal: readSolvedState(path.join(ctx.hordeDir, "runs", ctx.runId)).proposal } : {}) };
}

/** Omit only text the caller just submitted. Server-generated decisions and IDs stay visible. */
export function compactReceipt(text: string, params: HordeToolParams): string {
  if (params.detail === "full") return text;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(text); } catch { return text; }
  if (typeof payload.eventId !== "string") return text;
  const submitted = new Set([params.text, params.checked, params.unchecked, params.criteria, params.evidenceText].filter((v): v is string => typeof v === "string" && v.length > 160).map((s) => s.trim()));
  let shortened = false;
  const compact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(compact);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (PROSE.has(key) && typeof item === "string" && submitted.has(item.trim())) {
        shortened = true;
        return [key, { stored: true, chars: item.length }];
      }
      return [key, compact(item)];
    }));
  };
  const compacted = compact(payload) as Record<string, unknown>;
  if (!shortened) return text;
  const receipt = JSON.stringify({ ...compacted, read: `inspect target=${payload.eventId} for the full stored record; detail=full requests full write receipts` });
  return receipt.length < text.length ? receipt : text;
}
