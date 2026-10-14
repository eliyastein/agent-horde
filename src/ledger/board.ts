import * as fs from "node:fs";
import { formatDateTime, oneLine, taskHash } from "../format.js";
import { appendEntry, boardEntry, hordePaths, requireText } from "./files.js";
import type { FindingEntry } from "./findings.js";
import { withHordeLock } from "./lock.js";

function runHeading(runId: string, prompt: string, now: Date = new Date()): string {
  // Cite the full task by hash so the truncated prompt points at TASK.md rather than
  // standing in for it.
  return `\n## Run ${runId} (${formatDateTime(now)}): ${oneLine(prompt, 120)} [TASK.md sha256:${taskHash(prompt)}]\n`;
}

export async function postBoard(
  hordeDir: string,
  author: string,
  text: string | undefined,
): Promise<void> {
  const body = requireText(text, "post");
  await withHordeLock(hordeDir, author, () => {
    appendEntry(hordePaths(hordeDir).board, boardEntry(author, body));
  });
}

export async function appendRunHeading(
  hordeDir: string,
  runId: string,
  prompt: string,
): Promise<void> {
  const heading = runHeading(runId, prompt);
  await withHordeLock(hordeDir, "parent", () => {
    const paths = hordePaths(hordeDir);
    appendEntry(paths.board, heading);
    appendEntry(paths.findings, heading);
  });
}

export function countRunEntries(content: string, runId: string): number {
  let inRun = false;
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) inRun = line.startsWith(`## Run ${runId} `);
    else if (inRun && line.startsWith("### ")) count++;
  }
  return count;
}

/** One `### HH:MM:SS author` post in BOARD.md, attributed to the run heading above it. */
export interface BoardEntry {
  runId: string;
  time: string;
  author: string;
  text: string;
}

const BOARD_ENTRY_HEADING = /^### (\d{2}:\d{2}:\d{2}) (\S+)$/;

/** Parse BOARD.md; entries before any run heading get an empty runId. */
export function parseBoard(content: string): BoardEntry[] {
  const entries: BoardEntry[] = [];
  let runId = "";
  let current: BoardEntry | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (current) entries.push({ ...current, text: body.join("\n").trim() });
    current = undefined;
    body = [];
  };
  for (const line of content.split("\n")) {
    const run = RUN_HEADING.exec(line);
    if (run) {
      flush();
      runId = run[1] ?? "";
      continue;
    }
    const heading = BOARD_ENTRY_HEADING.exec(line);
    if (heading) {
      flush();
      current = { runId, time: heading[1] ?? "", author: heading[2] ?? "", text: "" };
      continue;
    }
    if (current) body.push(line.startsWith("\\#") ? line.slice(1) : line);
  }
  flush();
  return entries;
}

export function listBoard(hordeDir: string): BoardEntry[] {
  const file = hordePaths(hordeDir).board;
  if (!fs.existsSync(file)) return [];
  return parseBoard(fs.readFileSync(file, "utf-8"));
}

/**
 * Member board posts that landed after the last finding of the run. A result that
 * only reached BOARD.md during wrap-up would otherwise be invisible to REPORT.md.
 */
export function lateBoardPosts(hordeDir: string, runId: string, findings: FindingEntry[]): BoardEntry[] {
  const last = findings.reduce((max, finding) => (finding.time && finding.time > max ? finding.time : max), "");
  if (!last) return [];
  return listBoard(hordeDir).filter(
    (entry) =>
      entry.runId === runId && /^member-\d+$/.test(entry.author) && entry.time > last,
  );
}

/** The last board post each member made in a run, used to recover a killed member's summary. */
export function lastBoardPostsByMember(hordeDir: string, runId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of listBoard(hordeDir)) {
    if (entry.runId === runId && /^member-\d+$/.test(entry.author)) out.set(entry.author, entry.text);
  }
  return out;
}

export const RUN_HEADING = /^## Run (\S+) \(/;
