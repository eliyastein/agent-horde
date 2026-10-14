import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { collaborationState } from "./collaboration.js";
import type { PeerMessage, ReviewRecord } from "./collaboration.js";
import { formatClock } from "../format.js";
import { RUN_HEADING } from "./board.js";
import { registerConcern } from "./concerns.js";
import { appendEntry, hordePaths, neutralizeHeadings, requireText, writeFileAtomic } from "./files.js";
import { withHordeLock } from "./lock.js";
import { bestTextMatch, stripLeadingId } from "./text-match.js";

export async function postFinding(
  hordeDir: string,
  author: string,
  text: string | undefined,
): Promise<AddFindingResult> {
  return addFinding(hordeDir, "", author, text);
}

const FINDING_HEADING = /^### (\d{2}:\d{2}:\d{2}) (\S+?)(?: \[F(\d+)\])?((?:\s+\w+=[^\s]+)*)$/;

const HEADING_NO_ID = /^(### \d{2}:\d{2}:\d{2} \S+)((?:\s+\w+=[^\s]+)*)$/;

/** How much a finding matters for the task. Domain-neutral; optional. */
export const FINDING_IMPORTANCE = ["critical", "high", "medium", "low", "info"] as const;

export const FINDING_CONFIDENCES = ["high", "medium", "low"] as const;

/**
 * How strongly a finding is supported. Domain-neutral: `reproduced` (observed
 * end-to-end), `tested` (exercised in a controlled test), `derived` (computed
 * from primary data), `sourced` (read from primary sources), `speculative`
 * (reasoned or conjectured). Legacy security-research labels still parse.
 */
export const FINDING_SUPPORT = [
  "reproduced",
  "tested",
  "derived",
  "sourced",
  "speculative",
] as const;

/** Legacy evidence classes from earlier runs, mapped to the neutral support axis. */
const LEGACY_SUPPORT_MAP: Record<string, string> = {
  "runtime-reproduced": "reproduced",
  "live-validated": "reproduced",
  "integration-tested": "tested",
  "static-harness": "derived",
  "bundle-derived": "derived",
  "source-reviewed": "sourced",
  "source-verified": "sourced",
  inferred: "speculative",
};

/** Normalize a support label, new or legacy, to the neutral vocabulary. */
function normalizeSupport(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if ((FINDING_SUPPORT as readonly string[]).includes(lower)) return lower;
  return LEGACY_SUPPORT_MAP[lower] ?? lower;
}

export interface FindingMeta {
  ideaId?: number | undefined;
  /** How much this matters for the task: critical/high/medium/low/info. Optional. */
  importance?: string | undefined;
  confidence?: string | undefined;
  /** How strongly this is supported: reproduced/tested/derived/sourced/speculative. Optional. */
  support?: string | undefined;
  /** Stable subject or issue slug. Different concerns never deduplicate or cluster. */
  concern?: string | undefined;
  /** This finding is new evidence for an existing finding, not a duplicate. */
  deltaOf?: number | undefined;
  /** This finding overturns or corrects an earlier finding. */
  supersedes?: number | undefined;
  /** One-line definition when the concern is new to CONCERNS.md. */
  concernDef?: string | undefined;
  /** Register the concern even when it resembles an existing slug. */
  concernNew?: boolean | undefined;
}

export interface FindingEntry {
  id: number;
  runId: string;
  author: string;
  /** Clock time from the heading, used to spot board posts after the last finding. */
  time?: string | undefined;
  title: string;
  body: string;
  /** True when the file carried an explicit [F#]; false for legacy entries. */
  explicitId: boolean;
  ideaId?: number | undefined;
  importance?: string | undefined;
  confidence?: string | undefined;
  support?: string | undefined;
  concern?: string | undefined;
  deltaOf?: number | undefined;
  supersedes?: number | undefined;
  /** Set when another finding in this run declared it supersedes this one. */
  supersededBy?: number | undefined;
  /** Member that independently reproduced the finding with `horde verify`. */
  verifiedBy?: string | undefined;
  /** Support level the verifier reached. */
  verifiedSupport?: string | undefined;
  /** Other members who independently filed the same finding. */
  corroborators: string[];
  /** Index of this entry's heading in the file, for in-place metadata edits. */
  headingLine: number;
}

function metaNumber(value: string): number | undefined {
  const match = /(\d+)/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function parseFindingMeta(tail: string): Omit<
  FindingEntry,
  "id" | "runId" | "author" | "title" | "body" | "explicitId" | "headingLine"
> {
  const meta = {
    corroborators: [] as string[],
  } as Omit<FindingEntry, "id" | "runId" | "author" | "title" | "body" | "explicitId" | "headingLine">;
  for (const match of tail.matchAll(/(\w+)=([^\s]+)/g)) {
    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (key === "idea") meta.ideaId = metaNumber(value);
    // `imp` is current; `sev` is the legacy security label and still parses.
    else if (key === "imp" || key === "sev") meta.importance = value;
    else if (key === "conf") meta.confidence = value;
    // `sup` is current; `ev` is the legacy evidence class and still parses.
    else if (key === "sup" || key === "ev") meta.support = normalizeSupport(value);
    else if (key === "concern") meta.concern = value;
    else if (key === "delta") meta.deltaOf = metaNumber(value);
    else if (key === "supersedes") meta.supersedes = metaNumber(value);
    else if (key === "superseded") meta.supersededBy = metaNumber(value);
    else if (key === "verified") meta.verifiedBy = value;
    else if (key === "vsupport" || key === "vev") meta.verifiedSupport = normalizeSupport(value);
    else if (key === "corr") meta.corroborators = value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return meta;
}

function stripTrailing(text: string): string {
  return text.replace(/\n+$/, "");
}

/** Parse FINDINGS.md into entries and assign tentative ids to legacy entries. */
export function parseFindings(content: string): FindingEntry[] {
  const entries: FindingEntry[] = [];
  let runId = "";
  let current: FindingEntry | undefined;
  const flush = (): void => {
    if (current) entries.push(current);
    current = undefined;
  };
  for (const [lineIndex, line] of content.split("\n").entries()) {
    const run = RUN_HEADING.exec(line);
    if (run) {
      flush();
      runId = run[1] ?? "";
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      runId = "";
      continue;
    }
    const heading = FINDING_HEADING.exec(line);
    if (heading) {
      flush();
      const meta = parseFindingMeta(heading[4] ?? "");
      current = {
        id: heading[3] ? Number(heading[3]) : 0,
        runId,
        author: heading[2] ?? "",
        time: heading[1] ?? undefined,
        title: "",
        body: "",
        explicitId: Boolean(heading[2]),
        headingLine: lineIndex,
        ...meta,
      };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  flush();
  let next = 1;
  for (const entry of entries) if (entry.id >= next) next = entry.id + 1;
  for (const entry of entries) {
    if (entry.id === 0) entry.id = next++;
    entry.body = stripTrailing(entry.body);
    entry.title = entry.body.split("\n")[0] ?? "";
  }
  return entries;
}

/**
 * Give every legacy finding an explicit [F#] once. Without this, the pure
 * parser renumbers legacy entries above the max id on every read, so each new
 * finding jumps by the number of legacy entries.
 */
function stampFindingIds(content: string): string {
  const lines = content.split("\n");
  let next = 1;
  for (const line of lines) {
    const match = /^### \d{2}:\d{2}:\d{2} \S+ \[F(\d+)\]/.exec(line);
    if (match?.[1]) next = Math.max(next, Number(match[1]) + 1);
  }
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("### ") || /\[F\d+\]/.test(line)) continue;
    const match = HEADING_NO_ID.exec(line);
    if (!match) continue;
    lines[i] = `${match[1]} [F${next++}]${match[2] ?? ""}`;
    changed = true;
  }
  return changed ? lines.join("\n") : content;
}

/** Stamp any legacy findings with ids. Safe to call repeatedly. */
export async function ensureFindingIds(hordeDir: string): Promise<void> {
  return withHordeLock(hordeDir, "parent", () => {
    const findingsPath = hordePaths(hordeDir).findings;
    if (fs.existsSync(findingsPath)) readStampedFindings(findingsPath);
  });
}

function findingEntry(
  author: string,
  text: string,
  id: number,
  meta: FindingMeta = {},
  now: Date = new Date(),
): string {
  let tag = ` [F${id}]`;
  if (meta.ideaId !== undefined) tag += ` idea=#${meta.ideaId}`;
  if (meta.importance) tag += ` imp=${meta.importance}`;
  if (meta.confidence) tag += ` conf=${meta.confidence}`;
  if (meta.support) tag += ` sup=${normalizeSupport(meta.support) ?? meta.support}`;
  if (meta.concern) tag += ` concern=${meta.concern}`;
  if (meta.deltaOf !== undefined) tag += ` delta=#F${meta.deltaOf}`;
  if (meta.supersedes !== undefined) tag += ` supersedes=#F${meta.supersedes}`;
  return `\n### ${formatClock(now)} ${author}${tag}\n${neutralizeHeadings(text.trim())}\n`;
}

/** Record another independent member on an existing finding's heading. */
function addCorroborator(content: string, entry: FindingEntry, author: string): string {
  if (entry.author === author || entry.corroborators.includes(author)) return content;
  const lines = content.split("\n");
  const line = lines[entry.headingLine];
  if (line === undefined) return content;
  const base = line.replace(/\s+corr=[^\s]+/, "");
  lines[entry.headingLine] = `${base} corr=${[...entry.corroborators, author].join(",")}`;
  return lines.join("\n");
}

/** Annotate the superseded finding's heading so the correction is visible in the file. */
function addSupersededBy(content: string, entry: FindingEntry, byId: number): string {
  if (entry.supersededBy !== undefined) return content;
  const lines = content.split("\n");
  const line = lines[entry.headingLine];
  if (line === undefined) return content;
  lines[entry.headingLine] = `${line} superseded=#F${byId}`;
  return lines.join("\n");
}

interface AddFindingResult {
  finding: FindingEntry;
  /** Same-run duplicate: refused. */
  duplicateOf?: FindingEntry;
  /** True when this duplicate already had an independent validator. */
  corroborationFull?: boolean | undefined;
  /** Match from an earlier run: advisory. */
  relatedOf?: FindingEntry | undefined;
  /** A newly registered concern resembles an existing one: advisory. */
  concernAdvisory?: string | undefined;
}

/** What a new finding is checked and filed with. */
interface FindingDraft {
  runId: string;
  author: string;
  body: string;
  meta: FindingMeta;
}

/** Read FINDINGS.md, stamping ids onto legacy entries first so ids stay stable. */
function readStampedFindings(findingsPath: string): string {
  const content = fs.existsSync(findingsPath) ? fs.readFileSync(findingsPath, "utf-8") : "";
  const stamped = stampFindingIds(content);
  if (stamped !== content) writeFileAtomic(findingsPath, stamped);
  return stamped;
}

/** A delta must extend a finding in this run, under its concern, with distinct evidence. */
function checkDelta(scoped: FindingEntry[], { runId, body, meta }: FindingDraft): void {
  if (meta.deltaOf === undefined) return;
  const parent = scoped.find((entry) => entry.id === meta.deltaOf);
  if (!parent) {
    throw new Error(
      `horde: finding F${meta.deltaOf} is not in this run; a delta must reference a finding in run ${runId}`,
    );
  }
  if (parent.concern && meta.concern !== parent.concern) {
    throw new Error(
      `horde: delta F${parent.id} has concern=${parent.concern}; use that exact concern for new evidence, ` +
        "or file a separate finding for a different entry point/root cause",
    );
  }
  // Wording overlap cannot establish whether experimental evidence is new.
  void body;
}

/** Explicit corrections may change concern when the original diagnosis was wrong. */
function checkSupersedes(scoped: FindingEntry[], { runId, meta }: FindingDraft): void {
  if (meta.supersedes === undefined) return;
  const corrected = scoped.find((entry) => entry.id === meta.supersedes);
  if (!corrected) {
    throw new Error(
      `horde: finding F${meta.supersedes} is not in this run; supersedes must reference a finding in run ${runId}`,
    );
  }
}

/** The F# ids a body mentions must agree with the delta/supersedes it declares. */
function checkBodyReferences(scoped: FindingEntry[], { body, meta }: FindingDraft): void {
  // Explicit relation fields are authoritative. Other findings may be relevant citations.
  const scopedIds = new Set(scoped.map((entry) => entry.id));
  // A body that calls itself a correction of F# must use supersedes, so the
  // corrected finding moves out of the live results instead of sitting beside it.
  const correction = /\b(?:correction to|corrects|supersedes|overturns)\s+#?F?(\d+)\b/i.exec(body);
  if (correction) {
    const id = Number(correction[1]);
    if (scopedIds.has(id) && meta.supersedes !== id) {
      throw new Error(
        `horde: the body calls this a correction of F${id}; file it with supersedes: ${id} ` +
          `so the corrected finding leaves the live results`,
      );
    }
  }
}

/** A same-run finding under a compatible concern that already says the same thing. */
function sameRunDuplicate(scoped: FindingEntry[], { body, meta }: FindingDraft): FindingEntry | undefined {
  const comparable = scoped.filter(
    (entry) => !meta.concern || !entry.concern || entry.concern === meta.concern,
  );
  const match = bestTextMatch(
    comparable.map((entry) => `${entry.title}\n${entry.body}`),
    body,
  );
  return match === undefined ? undefined : comparable[match.index];
}

/** Record the author as a corroborator of a duplicate, up to one independent validator. */
function corroborate(
  findingsPath: string,
  content: string,
  existing: FindingEntry,
  author: string,
): AddFindingResult {
  const corroborationFull =
    existing.author !== author && !existing.corroborators.includes(author) && existing.corroborators.length >= 1;
  const updated = corroborationFull ? content : addCorroborator(content, existing, author);
  if (updated !== content) writeFileAtomic(findingsPath, updated);
  return { finding: existing, duplicateOf: existing, corroborationFull };
}

/** Append the finding with the next id, annotating the finding it supersedes. */
function appendFinding(
  findingsPath: string,
  content: string,
  all: FindingEntry[],
  { runId, author, body, meta }: FindingDraft,
): AddFindingResult {
  const others = all.filter(
    (entry) => entry.runId !== runId && (!meta.concern || !entry.concern || entry.concern === meta.concern),
  );
  const crossMatch = bestTextMatch(
    others.map((entry) => `${entry.title}\n${entry.body}`),
    body,
  );
  const id = all.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
  if (meta.supersedes !== undefined) {
    const target = all.find((entry) => entry.runId === runId && entry.id === meta.supersedes);
    if (target) {
      const annotated = addSupersededBy(content, target, id);
      if (annotated !== content) writeFileAtomic(findingsPath, annotated);
    }
  }
  appendEntry(findingsPath, findingEntry(author, body, id, meta));
  return {
    finding: {
      id,
      runId,
      author,
      title: body.split("\n")[0] ?? "",
      body,
      explicitId: true,
      corroborators: [],
      headingLine: -1,
      ...meta,
    },
    relatedOf: crossMatch === undefined ? undefined : others[crossMatch.index],
  };
}

export async function addFinding(
  hordeDir: string,
  runId: string,
  author: string,
  text: string | undefined,
  meta: FindingMeta = {},
): Promise<AddFindingResult> {
  meta = { ...meta, support: normalizeSupport(meta.support) };
  const raw = stripLeadingId(requireText(text, "finding"));
  const body = raw;
  const draft: FindingDraft = { runId, author, body, meta };
  return withHordeLock(hordeDir, author, () => {
    const findingsPath = hordePaths(hordeDir).findings;
    const content = readStampedFindings(findingsPath);
    const all = parseFindings(content);
    const scoped = all.filter((entry) => entry.runId === runId);
    checkDelta(scoped, draft);
    checkSupersedes(scoped, draft);
    checkBodyReferences(scoped, draft);
    // A delta or correction inherits an existing concern; anything else must be
    // in the glossary before it can be filed.
    let concernAdvisory: string | undefined;
    if (meta.deltaOf === undefined && meta.supersedes === undefined) {
      const usedSlugs = new Set(all.map((entry) => entry.concern).filter(Boolean) as string[]);
      concernAdvisory = registerConcern(hordeDir, usedSlugs, meta, author);
    }
    // A declared delta is new evidence, so it bypasses duplicate detection.
    const duplicate = meta.deltaOf === undefined && meta.supersedes === undefined ? sameRunDuplicate(scoped, draft) : undefined;
    if (duplicate) return corroborate(findingsPath, content, duplicate, author);
    return { ...appendFinding(findingsPath, content, all, draft), concernAdvisory };
  });
}

interface VerifyFindingResult {
  finding: FindingEntry;
  /** Set when the finding already carried a verifier; nothing was written. */
  alreadyBy?: string | undefined;
}

/**
 * Record an independent reproduction on a finding's heading (`verified=` and
 * `vev=`) and append the verifier's note to its body. The reporter and its
 * corroborators cannot verify: `corr=` means "also reported", `verified=` means
 * "reproduced by someone else".
 */
interface VerifyFindingInput {
  id: number;
  /** Support level the verifier reached; legacy evidence classes are normalized. */
  support: string | undefined;
  text: string | undefined;
}

export async function verifyFinding(
  hordeDir: string,
  runId: string,
  member: string,
  { id, support: level, text }: VerifyFindingInput,
): Promise<VerifyFindingResult> {
  const note = requireText(text, "verify");
  const support = normalizeSupport(level);
  if (!support || support === "speculative" || !(FINDING_SUPPORT as readonly string[]).includes(support)) {
    throw new Error(
      `horde: verify needs the support level you reached: ${FINDING_SUPPORT.join(", ")}`,
    );
  }
  return withHordeLock(hordeDir, member, () => {
    const findingsPath = hordePaths(hordeDir).findings;
    const content = readStampedFindings(findingsPath);
    const entry = parseFindings(content).find((f) => f.runId === runId && f.id === id);
    if (!entry) {
      throw new Error(
        `horde: finding F${id} is not in run ${runId}; verify only this run's findings`,
      );
    }
    if (entry.author === member) {
      throw new Error(
        `horde: ${member} reported F${id}; the reporter cannot verify their own finding`,
      );
    }
    const lines = content.split("\n");
    if (!entry.verifiedBy) lines[entry.headingLine] = `${lines[entry.headingLine]} verified=${member} vsupport=${support}`;
    const bodyEnd = entry.headingLine + 1 + entry.body.split("\n").length;
    lines.splice(bodyEnd, 0, "", `Verified by ${member} [${support}]: ${neutralizeHeadings(note)}`);
    writeFileAtomic(findingsPath, lines.join("\n"));
    return { finding: { ...entry, verifiedBy: entry.verifiedBy ?? member, verifiedSupport: entry.verifiedSupport ?? support }, alreadyBy: entry.verifiedBy };
  });
}

export function listFindingsForRun(hordeDir: string, runId: string): FindingEntry[] {
  const findingsPath = hordePaths(hordeDir).findings;
  if (!fs.existsSync(findingsPath)) return [];
  return parseFindings(fs.readFileSync(findingsPath, "utf-8")).filter(
    (entry) => entry.runId === runId,
  );
}

/** Review notes are separate evidence and do not change the claim's revision. */
export function findingRevision(entry: FindingEntry): string {
  const subject = (entry.body.split(/\n(?:Verified|Reviewed) by /)[0] ?? entry.body).trimEnd();
  return createHash("sha256").update(subject).digest("hex");
}

interface FindingReviewState {
  status: "superseded" | "unreviewed" | "limited" | "full" | "disputed" | "legacy";
  reviews: ReviewRecord[];
}

/** One review classification for reports, acceptance and pending queues. Never infer scope from prose. */
export function findingReviewState(entry: FindingEntry, reviews: ReviewRecord[] = [], messages: PeerMessage[] = []): FindingReviewState {
  const target = `F${entry.id}`;
  const current = reviews.filter((r) => r.target === target && r.revision === findingRevision(entry) && r.actor !== entry.author);
  const latest = [...new Map(current.map((r) => [r.actor, r])).values()];
  let status: FindingReviewState["status"];
  if (entry.supersededBy !== undefined) status = "superseded";
  else if (messages.some((m) => m.target === target && m.blocking && m.state !== "resolved") || latest.some((r) => r.verdict === "refutes")) status = "disputed";
  else if (latest.some((r) => r.verdict === "supports" && !r.unchecked.trim())) status = "full";
  else if (current.length) status = "limited";
  else status = entry.verifiedBy && !reviews.some((r) => r.target === target) ? "legacy" : "unreviewed";
  return { status, reviews: current };
}

/** A disclosed limitation is not a request to repeat the same member's check. */
export function pendingReviewsForMember(hordeDir: string, runId: string, member: string): FindingEntry[] {
  const state = collaborationState(hordeDir, runId);
  return unverifiedFindings(hordeDir, runId).filter((finding) => finding.author !== member &&
    !state.reviews.some((r) => r.target === `F${finding.id}` && r.revision === findingRevision(finding) && r.actor === member));
}

/** Current claims without a full independent check, including explicitly disputed ones. */
export function unverifiedFindings(hordeDir: string, runId: string): FindingEntry[] {
  const state = collaborationState(hordeDir, runId);
  return listFindingsForRun(hordeDir, runId).filter((entry) => {
    return ["unreviewed", "limited", "disputed"].includes(findingReviewState(entry, state.reviews, state.messages).status);
  });
}

/** Compact one-line summaries for a run, so members do not read the whole file. */
export function findingSummaries(hordeDir: string, runId: string): string {
  const entries = listFindingsForRun(hordeDir, runId);
  if (entries.length === 0) return `no findings recorded for run ${runId} yet`;
  const state = collaborationState(hordeDir, runId);
  return entries
    .map((entry) => {
      const parts = [entry.importance, entry.confidence, entry.support].filter(Boolean);
      const meta = parts.length > 0 ? ` [${parts.join("/")}]` : "";
      const idea = entry.ideaId !== undefined ? ` (idea #${entry.ideaId})` : "";
      const concern = entry.concern ? ` concern=${entry.concern}` : "";
      const delta = entry.deltaOf !== undefined ? ` delta of F${entry.deltaOf}` : "";
      const supersedes = entry.supersedes !== undefined ? ` supersedes F${entry.supersedes}` : "";
      const supersededBy = entry.supersededBy !== undefined ? ` superseded by F${entry.supersededBy}` : "";
      const corr = entry.corroborators.length > 0 ? ` +${entry.corroborators.join(",")}` : "";
      const check = findingReviewState(entry, state.reviews, state.messages);
      const verified = check.status === "legacy" ? ` verified by ${entry.verifiedBy} (legacy label)` : "";
      const scoped = ` review=${check.status}` + (check.reviews.length ? ` scoped reviews: ${check.reviews.map((r) => `${r.id} ${r.actor} ${r.verdict}/${r.support}${r.unchecked ? " (limited)" : ""}`).join(", ")}; inspect collaboration for remaining gaps` : "");
      return (
        `F${entry.id}${meta} ${entry.title}${idea}${concern}${delta}${supersedes}` +
        `${supersededBy}${corr}${verified}${scoped}`
      );
    })
    .join("\n");
}

const IMPORTANCE_RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

const SUPPORT_RANK: Record<string, number> = {
  reproduced: 5,
  tested: 4,
  derived: 3,
  sourced: 2,
  speculative: 1,
};

export function findingSupportRank(entry: FindingEntry): number {
  return SUPPORT_RANK[normalizeSupport(entry.support) ?? ""] ?? 0;
}

export function findingImportanceRank(entry: FindingEntry): number {
  return IMPORTANCE_RANK[(entry.importance ?? "").toLowerCase()] ?? 0;
}

export function findingConfidenceRank(entry: FindingEntry): number {
  return CONFIDENCE_RANK[(entry.confidence ?? "").toLowerCase()] ?? 0;
}
