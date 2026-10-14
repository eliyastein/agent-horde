import * as fs from "node:fs";
import * as path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { oneLine } from "./format.js";
import { memberSessionDir, summarizeToolArg } from "./member.js";
import type { MemberUsage } from "./member.js";

export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_ENTRIES = 200;
const LIST_TEXT_CHARS = 4_000;
const LIST_ARGS_CHARS = 2_000;
const LIST_RESULT_CHARS = 1_500;
const FULL_PART_CHARS = 512 * 1024;
const STATS_CACHE_MAX = 64;

/** Thrown when a session file exceeds `MAX_SESSION_BYTES`. */
export class SessionTooLargeError extends Error {
  constructor(filePath: string, bytes: number) {
    super(`session file ${path.basename(filePath)} is ${bytes} bytes, above the ${MAX_SESSION_BYTES} limit`);
  }
}

export type TranscriptPart =
  | { type: "text"; text: string; truncated?: boolean }
  | { type: "thinking"; chars: number; thinking?: string; truncated?: boolean }
  | { type: "toolCall"; id: string; name: string; summary: string; args: string; truncated?: boolean }
  | { type: "other"; label: string };

/** One session file line, reduced to what the dashboard renders. */
export interface TranscriptEntry {
  index: number;
  kind: string;
  timestamp?: string | undefined;
  role?: string | undefined;
  parts: TranscriptPart[];
  usage?: MemberUsage | undefined;
  model?: string | undefined;
  stopReason?: string | undefined;
  toolName?: string | undefined;
  isError?: boolean | undefined;
  /** Free-form summary for non-message entries, e.g. the model of a model_change. */
  detail?: string | undefined;
}

export interface SessionPage {
  entries: TranscriptEntry[];
  from: number;
  n: number;
  total: number;
  hasMore: boolean;
  sessionId?: string | undefined;
  cwd?: string | undefined;
}

export interface SessionStats {
  entries: number;
  turns: number;
  toolCalls: number;
  usage: MemberUsage;
  first?: string | undefined;
  last?: string | undefined;
}

export interface SessionFileInfo {
  name: string;
  sessionId: string;
  bytes: number;
  mtimeMs: number;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  return value && typeof value === "object" ? (value as Rec) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** Read and parse a session file; malformed and partial trailing lines are skipped. */
function readSessionEntries(filePath: string): FileEntry[] {
  const bytes = fs.statSync(filePath).size;
  if (bytes > MAX_SESSION_BYTES) throw new SessionTooLargeError(filePath, bytes);
  return parseSessionEntries(fs.readFileSync(filePath, "utf-8"));
}

function usageOf(message: Rec): MemberUsage | undefined {
  if (!message.usage || typeof message.usage !== "object") return undefined;
  const usage = rec(message.usage);
  return {
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    cost: num(rec(usage.cost).total),
  };
}

function contentPart(part: unknown, full: boolean, resultChars: number): TranscriptPart {
  const p = rec(part);
  switch (p.type) {
    case "text": {
      const clipped = clip(str(p.text) ?? "", full ? FULL_PART_CHARS : resultChars);
      return { type: "text", text: clipped.text, truncated: clipped.truncated };
    }
    case "thinking": {
      const thinking = str(p.thinking) ?? "";
      if (!full) return { type: "thinking", chars: thinking.length };
      const clipped = clip(thinking, FULL_PART_CHARS);
      return { type: "thinking", chars: thinking.length, thinking: clipped.text, truncated: clipped.truncated };
    }
    case "toolCall": {
      const name = str(p.name) ?? "tool";
      const clipped = clip(JSON.stringify(p.arguments ?? {}, null, 1), full ? FULL_PART_CHARS : LIST_ARGS_CHARS);
      return {
        type: "toolCall",
        id: str(p.id) ?? "",
        name,
        summary: oneLine(summarizeToolArg(name, p.arguments), 120),
        args: clipped.text,
        truncated: clipped.truncated,
      };
    }
    case "image":
      return { type: "other", label: `image ${str(p.mimeType) ?? ""}`.trim() };
    default:
      return { type: "other", label: str(p.type) ?? "unknown part" };
  }
}

function messageParts(message: Rec, full: boolean): TranscriptPart[] {
  const resultChars = message.role === "toolResult" ? LIST_RESULT_CHARS : LIST_TEXT_CHARS;
  if (typeof message.content === "string") return [contentPart({ type: "text", text: message.content }, full, resultChars)];
  if (!Array.isArray(message.content)) return [];
  return message.content.map((part) => contentPart(part, full, resultChars));
}

/** Reduce one parsed entry to a `TranscriptEntry`; `full` keeps whole parts (single-entry view). */
function toTranscriptEntry(entry: FileEntry, index: number, full: boolean): TranscriptEntry {
  const e = rec(entry);
  const base: TranscriptEntry = { index, kind: str(e.type) ?? "unknown", timestamp: str(e.timestamp), parts: [] };
  switch (e.type) {
    case "message": {
      const message = rec(e.message);
      const isError = message.isError;
      return {
        ...base,
        role: str(message.role),
        parts: messageParts(message, full),
        usage: usageOf(message),
        model: str(message.model),
        stopReason: str(message.stopReason),
        toolName: str(message.toolName),
        isError: typeof isError === "boolean" ? isError : undefined,
      };
    }
    case "session":
      return { ...base, detail: `session ${str(e.id) ?? ""} in ${str(e.cwd) ?? ""}` };
    case "model_change":
      return { ...base, detail: `${str(e.provider) ?? ""}/${str(e.modelId) ?? ""}` };
    case "thinking_level_change":
      return { ...base, detail: str(e.thinkingLevel) };
    default:
      return { ...base, detail: oneLine(JSON.stringify(entry), 200) };
  }
}

/** A page of entries; `from` is an entry index or "last" for the tail. `n` is clamped to 1..200. */
export function readSessionPage(filePath: string, from: number | "last", n: number): SessionPage {
  const entries = readSessionEntries(filePath);
  const total = entries.length;
  const size = Math.min(MAX_PAGE_ENTRIES, Math.max(1, Math.floor(n) || 1));
  const start = from === "last" ? Math.max(0, total - size) : Math.min(Math.max(0, Math.floor(from)), total);
  const header = rec(entries[0]);
  return {
    entries: entries.slice(start, start + size).map((entry, i) => toTranscriptEntry(entry, start + i, false)),
    from: start,
    n: size,
    total,
    hasMore: start + size < total,
    sessionId: header.type === "session" ? str(header.id) : undefined,
    cwd: header.type === "session" ? str(header.cwd) : undefined,
  };
}

export function readSessionEntry(filePath: string, index: number): TranscriptEntry | undefined {
  const entry = readSessionEntries(filePath)[index];
  return entry ? toTranscriptEntry(entry, index, true) : undefined;
}

export function rawSessionEntry(filePath: string, index: number): string | undefined {
  const entry = readSessionEntries(filePath)[index];
  return entry ? JSON.stringify(entry, null, 1) : undefined;
}

const statsCache = new Map<string, { key: string; stats: SessionStats }>();

function computeStats(entries: FileEntry[]): SessionStats {
  const stats: SessionStats = {
    entries: entries.length,
    turns: 0,
    toolCalls: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  };
  for (const entry of entries) {
    const e = rec(entry);
    if (e.type === "session") continue;
    stats.first ??= str(e.timestamp);
    stats.last = str(e.timestamp) ?? stats.last;
    if (e.type !== "message") continue;
    const message = rec(e.message);
    if (message.role !== "assistant") continue;
    stats.turns++;
    const usage = usageOf(message);
    if (usage) {
      stats.usage.input += usage.input;
      stats.usage.output += usage.output;
      stats.usage.cacheRead += usage.cacheRead;
      stats.usage.cacheWrite += usage.cacheWrite;
      stats.usage.cost += usage.cost;
    }
    if (Array.isArray(message.content)) {
      stats.toolCalls += message.content.filter((part) => rec(part).type === "toolCall").length;
    }
  }
  return stats;
}

/** Per-file totals, cached by size and mtime so repeated dashboard polls stay cheap. */
export function sessionStats(filePath: string): SessionStats {
  const stat = fs.statSync(filePath);
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = statsCache.get(filePath);
  if (cached && cached.key === key) return cached.stats;
  if (statsCache.size >= STATS_CACHE_MAX) statsCache.clear();
  const stats = computeStats(readSessionEntries(filePath));
  statsCache.set(filePath, { key, stats });
  return stats;
}

export function sessionIdFromName(name: string): string {
  const stem = name.replace(/\.jsonl$/, "");
  const underscore = stem.indexOf("_");
  return underscore === -1 ? stem : stem.slice(underscore + 1);
}

/** The `.jsonl` files directly inside `dir`, sorted by name (pi prefixes a timestamp). */
export function listSessionFiles(dir: string): SessionFileInfo[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const stat = fs.statSync(path.join(dir, entry.name));
      return { name: entry.name, sessionId: sessionIdFromName(entry.name), bytes: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Newest session file of a member (a canary retry can leave two), or undefined. */
export function memberSessionFile(runDir: string, member: string): string | undefined {
  const dir = memberSessionDir(runDir, member);
  const files = listSessionFiles(dir);
  const newest = files[files.length - 1];
  return newest ? path.join(dir, newest.name) : undefined;
}
