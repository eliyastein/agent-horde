import { createHash } from "node:crypto";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Short, stable digest of the full task text, cited by ledgers next to a truncated prompt. */
export function taskHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 12);
}

/** The URL key of a collapsible dashboard entry, so a link elsewhere can open it on arrival. */
export function detailKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

export function formatClock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatDateTime(d: Date): string {
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${date} ${formatClock(d)}`;
}

export function formatRunId(d: Date): string {
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  return `${date}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${pad2(minutes)}m`;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 999_950) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const hard = collapsed.slice(0, Math.max(0, max - 1));
  // Break on the last word boundary when one is close, so the ellipsis does not
  // land mid-word; fall back to the hard cut for a single very long token.
  const lastSpace = hard.lastIndexOf(" ");
  const wordCut = lastSpace >= max - 16 && lastSpace > 0 ? hard.slice(0, lastSpace) : hard;
  return `${wordCut.trimEnd()}…`;
}

/**
 * Numeric tuning knob from the environment. Unlike `Number(env) || fallback`,
 * an explicit `0` is honoured, so a knob can be switched off.
 */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
