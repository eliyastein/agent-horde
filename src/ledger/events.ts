import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { withHordeLock } from "./lock.js";

export interface HordeEvent {
  schema: 1;
  seq: number;
  eventId: string;
  at: string;
  runId: string;
  actor: string;
  attempt: string;
  requestId: string;
  inputHash?: string;
  action: string;
  outcome: "applied" | "rejected" | "noop" | "intent";
  parents: string[];
  payload: Record<string, unknown>;
}

export interface EventContext {
  hordeDir: string;
  runId: string;
  actor: string;
  attempt?: string;
  requestId?: string;
  inputHash?: string;
}

export function eventPath(hordeDir: string, runId: string): string {
  if (!/^[\w-]+$/.test(runId)) throw new Error("horde: invalid run id");
  return path.join(hordeDir, "runs", runId, "events.jsonl");
}

/** Ignore only an unterminated tail. Corrupt committed records fail closed. */
export function readEvents(hordeDir: string, runId: string): HordeEvent[] {
  const file = eventPath(hordeDir, runId);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.slice(0, raw.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
  return lines.map((line, i) => {
    const event = JSON.parse(line) as HordeEvent;
    if (event.schema !== 1 || event.seq !== i + 1 || event.runId !== runId || !event.payload) {
      throw new Error(`horde: corrupt event log at sequence ${i + 1}`);
    }
    return event;
  });
}

/** Caller holds .horde/.lock. Discard a torn tail, preserving it for diagnosis. */
function appendCommitted(ctx: EventContext, event: HordeEvent): void {
  const file = eventPath(ctx.hordeDir, ctx.runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const bytes = fs.readFileSync(file);
    const end = bytes.lastIndexOf(10) + 1;
    if (end < bytes.length) {
      fs.writeFileSync(`${file}.torn-${randomUUID()}`, bytes.subarray(end));
      fs.truncateSync(file, end);
    }
  }
  const fd = fs.openSync(file, "a");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(event)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export interface EventDraft {
  payload: Record<string, unknown>;
  outcome?: HordeEvent["outcome"];
  parents?: string[];
}

/** Atomic validation + append; replay is authoritative, so projections may lag safely. */
export async function transactEvent(
  ctx: EventContext,
  action: string,
  decide: (events: HordeEvent[], seq: number) => EventDraft,
): Promise<HordeEvent> {
  const requestId = ctx.requestId ?? randomUUID();
  return withHordeLock(ctx.hordeDir, ctx.actor, () => {
    const events = readEvents(ctx.hordeDir, ctx.runId);
    const previous = events.find((e) => e.actor === ctx.actor && e.attempt === (ctx.attempt ?? "legacy") && e.requestId === requestId);
    if (previous) {
      if (previous.action !== action || (ctx.inputHash && previous.inputHash !== ctx.inputHash)) throw new Error("horde: request id reused for a different command");
      return previous;
    }
    let draft: EventDraft;
    try {
      draft = decide(events, events.length + 1);
    } catch (error) {
      draft = { outcome: "rejected", payload: { error: error instanceof Error ? error.message : String(error) } };
    }
    const event: HordeEvent = {
      schema: 1, seq: events.length + 1, eventId: `E${events.length + 1}`, at: new Date().toISOString(),
      runId: ctx.runId, actor: ctx.actor, attempt: ctx.attempt ?? "legacy", requestId, inputHash: ctx.inputHash, action,
      outcome: draft.outcome ?? "applied", parents: draft.parents ?? [], payload: draft.payload,
    };
    appendCommitted(ctx, event);
    return event;
  });
}

export async function recordEvent(ctx: EventContext, action: string, draft: EventDraft): Promise<HordeEvent> {
  return transactEvent(ctx, action, () => draft);
}
