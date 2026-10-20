import * as fs from "node:fs";
import { oneLine } from "../format.js";
import { CLUSTER_THRESHOLD } from "./clusters.js";
import { appendEntry, boardEntry, hordePaths, requireText, writeFileAtomic } from "./files.js";
import { withHordeLock } from "./lock.js";
import { bestTextMatch, hardOverlap, textOverlap } from "./text-match.js";

type IdeaMark = " " | "~" | "x" | "!";

export interface Idea {
  id: number;
  mark: IdeaMark;
  text: string;
  owner?: string;
  note?: string;
}

interface IdeasDoc {
  lines: string[];
  ideas: Map<number, { index: number; idea: Idea }>;
}

const IDEA_LINE = /^- \[([ ~x!])\] #(\d+) (.+?)(?:\s{2}@(member-\d+)(?:: (.*))?)?$/;

export function parseIdeaLine(line: string): Idea | undefined {
  const match = IDEA_LINE.exec(line);
  if (!match) return undefined;
  const idea: Idea = { id: Number(match[2]), mark: match[1] as IdeaMark, text: match[3] ?? "" };
  if (match[4]) idea.owner = match[4];
  if (match[5]) idea.note = match[5];
  return idea;
}

export function parseIdeas(content: string): IdeasDoc {
  const lines = content.split("\n");
  const ideas = new Map<number, { index: number; idea: Idea }>();
  lines.forEach((line, index) => {
    const idea = parseIdeaLine(line);
    if (idea) ideas.set(idea.id, { index, idea });
  });
  return { lines, ideas };
}

export function formatIdea(idea: Idea): string {
  let line = `- [${idea.mark}] #${idea.id} ${idea.text}`;
  if (idea.owner) line += `  @${idea.owner}`;
  if (idea.owner && idea.note) line += `: ${idea.note}`;
  return line;
}

export function nextIdeaId(doc: IdeasDoc): number {
  let max = 0;
  for (const id of doc.ideas.keys()) if (id > max) max = id;
  return max + 1;
}

export function countIdeas(
  doc: IdeasDoc,
): { open: number; inProgress: number; done: number; dead: number } {
  const counts = { open: 0, inProgress: 0, done: 0, dead: 0 };
  for (const { idea } of doc.ideas.values()) {
    if (idea.mark === " ") counts.open++;
    else if (idea.mark === "~") counts.inProgress++;
    else if (idea.mark === "!") counts.dead++;
    else counts.done++;
  }
  return counts;
}

/**
 * Return an existing idea that covers `text`, including done and ruled-out
 * ideas, so finished or dead work is not restated as new.
 */
function findDuplicateIdea(doc: IdeasDoc, text: string): Idea | undefined {
  const candidates = [...doc.ideas.values()].map((entry) => entry.idea);
  const match = bestTextMatch(candidates.map((idea) => idea.text), text);
  return match === undefined ? undefined : candidates[match.index];
}

/** The live checklist, oldest idea first. Cheap enough for members to re-read mid-turn. */
export function listIdeas(hordeDir: string): Idea[] {
  const doc = readIdeasDoc(hordeDir);
  return [...doc.ideas.values()]
    .map((entry) => entry.idea)
    .sort((a, b) => a.id - b.id);
}

function readIdeasDoc(hordeDir: string): IdeasDoc {
  return parseIdeas(fs.readFileSync(hordePaths(hordeDir).ideas, "utf-8"));
}

function writeIdeasDoc(hordeDir: string, doc: IdeasDoc): void {
  writeFileAtomic(hordePaths(hordeDir).ideas, doc.lines.join("\n"));
}

function requireIdea(doc: IdeasDoc, id: number): { index: number; idea: Idea } {
  const entry = doc.ideas.get(id);
  if (!entry) throw new Error(`horde: idea #${id} does not exist; read IDEAS.md for current ids`);
  return entry;
}

interface AddIdeaResult {
  idea: Idea;
  /** Set when the idea was not added because an existing idea already covers it. */
  duplicateOf?: Idea;
}

export async function addIdea(
  hordeDir: string,
  author: string,
  text: string | undefined,
): Promise<AddIdeaResult> {
  const ideaText = oneLine(requireText(text, "idea"), 400);
  return withHordeLock(hordeDir, author, () => {
    const doc = readIdeasDoc(hordeDir);
    const duplicateOf = findDuplicateIdea(doc, ideaText);
    if (duplicateOf) return { idea: duplicateOf, duplicateOf };
    const idea: Idea = { id: nextIdeaId(doc), mark: " ", text: ideaText };
    const trailingBlank = doc.lines.length > 0 && doc.lines[doc.lines.length - 1] === "";
    if (trailingBlank) doc.lines.pop();
    doc.lines.push(formatIdea(idea), "");
    writeIdeasDoc(hordeDir, doc);
    return { idea };
  });
}

interface ClaimIdeaResult {
  idea: Idea;
  /** Another member holds a similar idea in progress; a soft warning, not a refusal. */
  overlap?: { id: number; owner: string; text: string } | undefined;
}

export async function claimIdea(
  hordeDir: string,
  owner: string,
  id: number,
  options: { checkOverlap?: boolean } = {},
): Promise<ClaimIdeaResult> {
  return withHordeLock(hordeDir, owner, () => {
    const doc = readIdeasDoc(hordeDir);
    const { index, idea } = requireIdea(doc, id);
    if (idea.mark === "x") throw new Error(`horde: idea #${id} is already done`);
    if (idea.mark === "!") throw new Error(`horde: idea #${id} was already ruled out: ${idea.note ?? "dead end"}`);
    if (idea.owner && idea.owner !== owner) {
      throw new Error(
        `horde: idea #${id} is already claimed by ${idea.owner}; ` +
          "pick another idea or add a new one",
      );
    }
    // Collision check against the work other members currently hold. Idea dedup
    // runs at write time, so two members can still add and claim near-identical
    // work before either sees the other; this serializes that decision.
    if (options.checkOverlap !== false) {
      const others = [...doc.ideas.values()]
        .map((entry) => entry.idea)
        .filter((other) => other.id !== id && other.mark === "~" && other.owner && other.owner !== owner);
      const match = textOverlap(
        others.map((other) => other.text),
        idea.text,
      );
      const other = match ? others[match.index] : undefined;
      if (match && other) {
        // A "decisive" match means the two ideas are the same slice, not two angles
        // on one topic: near-identical text, or several shared stemmed terms.
        const decisive =
          hardOverlap(match) || (match.shared >= 3 && Math.max(match.jaccard, match.overlap) >= 0.5);
        if (decisive) {
          // Rule out the losing idea, linked to the winner, so a refused claim does
          // not leave an open orphan that coverage counts forever. Only a still-open
          // idea is touched; work the caller already holds is left alone.
          if (idea.mark === " ") {
            const ruled: Idea = { id, mark: "!", text: idea.text, owner, note: `dup of #${other.id}` };
            doc.lines[index] = formatIdea(ruled);
            writeIdeasDoc(hordeDir, doc);
          }
          throw new Error(
            `horde: idea #${id} is the same work as #${other.id} held by ${other.owner}: "${other.text}". ` +
              `Attach your evidence to #${other.id} with a finding or contest, or pick a different slice`,
          );
        }
        if (Math.max(match.jaccard, match.overlap) >= CLUSTER_THRESHOLD) {
          const claimed: Idea = { id, mark: "~", text: idea.text, owner };
          doc.lines[index] = formatIdea(claimed);
          writeIdeasDoc(hordeDir, doc);
          return { idea: claimed, overlap: { id: other.id, owner: other.owner!, text: other.text } };
        }
      }
    }
    const claimed: Idea = { id, mark: "~", text: idea.text, owner };
    doc.lines[index] = formatIdea(claimed);
    writeIdeasDoc(hordeDir, doc);
    return { idea: claimed };
  });
}

export async function finishIdea(
  hordeDir: string,
  owner: string,
  id: number,
  note: string | undefined,
): Promise<Idea> {
  return withHordeLock(hordeDir, owner, () => {
    const doc = readIdeasDoc(hordeDir);
    const { index, idea } = requireIdea(doc, id);
    if (idea.owner !== owner) {
      const holder = idea.owner ? `claimed by ${idea.owner}` : "not claimed";
      throw new Error(`horde: idea #${id} is ${holder}; you can only finish ideas you claimed`);
    }
    const finished: Idea = { id, mark: "x", text: idea.text, owner };
    const noteText = oneLine(note ?? "", 300);
    if (noteText) finished.note = noteText;
    doc.lines[index] = formatIdea(finished);
    writeIdeasDoc(hordeDir, doc);
    return finished;
  });
}

/**
 * Release a claimed idea back to the pool, or retire an unclaimed one you added. `author` is the
 * member whose write created the idea, when the caller knows it; an unclaimed idea is dropped only
 * by its author, so folding your own duplicate does not require claiming it first.
 */
export async function dropIdea(
  hordeDir: string,
  owner: string,
  id: number,
  reason: string | undefined,
  options: { author?: string | undefined } = {},
): Promise<Idea> {
  return withHordeLock(hordeDir, owner, () => {
    const doc = readIdeasDoc(hordeDir);
    const { index, idea } = requireIdea(doc, id);
    if (idea.owner && idea.owner !== owner) {
      throw new Error(`horde: idea #${id} is claimed by ${idea.owner}; you can only drop ideas you claimed`);
    }
    if (!idea.owner && options.author !== owner) {
      throw new Error(`horde: idea #${id} is not claimed; only the member who added it or its claimant can drop it`);
    }
    const dropped: Idea = { id, mark: " ", text: idea.text };
    doc.lines[index] = formatIdea(dropped);
    writeIdeasDoc(hordeDir, doc);
    const reasonText = oneLine(reason ?? "", 300) || "no reason given";
    appendEntry(hordePaths(hordeDir).board, boardEntry(owner, `dropped #${id}: ${reasonText}`));
    return dropped;
  });
}

/** Terminal state for a confirmed negative result so a later run does not retry it. */
export async function ruleOutIdea(
  hordeDir: string,
  owner: string,
  id: number,
  reason: string | undefined,
): Promise<Idea> {
  return withHordeLock(hordeDir, owner, () => {
    const doc = readIdeasDoc(hordeDir);
    const { index, idea } = requireIdea(doc, id);
    if (idea.owner && idea.owner !== owner) {
      throw new Error(`horde: idea #${id} is claimed by ${idea.owner}; you cannot rule it out`);
    }
    const reasonText = oneLine(reason ?? "", 300) || "confirmed dead end";
    const ruled: Idea = { id, mark: "!", text: idea.text, owner, note: reasonText };
    doc.lines[index] = formatIdea(ruled);
    writeIdeasDoc(hordeDir, doc);
    appendEntry(hordePaths(hordeDir).board, boardEntry(owner, `ruled out #${id}: ${reasonText}`));
    return ruled;
  });
}

/** Seed one open idea per workstream, bypassing dedup, for a partitioned run. */
export async function seedPlan(hordeDir: string, layers: string[]): Promise<Idea[]> {
  return withHordeLock(hordeDir, "parent", () => {
    const doc = readIdeasDoc(hordeDir);
    const seeded: Idea[] = [];
    for (const layer of layers) {
      const idea: Idea = { id: nextIdeaId(doc), mark: " ", text: oneLine(layer, 400) };
      const trailingBlank = doc.lines.length > 0 && doc.lines[doc.lines.length - 1] === "";
      if (trailingBlank) doc.lines.pop();
      doc.lines.push(formatIdea(idea), "");
      doc.ideas.set(idea.id, { index: doc.lines.length - 2, idea });
      seeded.push(idea);
    }
    if (seeded.length > 0) writeIdeasDoc(hordeDir, doc);
    return seeded;
  });
}

interface ReconcileResult {
  closed: Array<{ id: number; findingId: number }>;
  released: number[];
}

/**
 * Reconcile ideas owned by members of a run that ended abnormally. An owned
 * in-progress idea that a finding for this run references is closed as done;
 * any other owned in-progress idea is returned to the open pool. This keeps
 * IDEAS.md from lying after a stop or crash.
 */
export async function reconcileOwnedIdeas(
  hordeDir: string,
  runId: string,
  owners: string[],
): Promise<ReconcileResult> {
  if (owners.length === 0) return { closed: [], released: [] };
  const ownerSet = new Set(owners);
  return withHordeLock(hordeDir, "parent", () => {
    const doc = readIdeasDoc(hordeDir);
    // Completion requires an explicit done/rule-out action, never a mention in evidence.
    void runId;
    const closed: Array<{ id: number; findingId: number }> = [];
    const released: number[] = [];
    for (const { index, idea } of doc.ideas.values()) {
      if (idea.mark !== "~" || !idea.owner || !ownerSet.has(idea.owner)) continue;
      doc.lines[index] = formatIdea({ id: idea.id, mark: " ", text: idea.text, note: "unfinished work released at reconciliation" });
      released.push(idea.id);
    }
    if (closed.length > 0 || released.length > 0) writeIdeasDoc(hordeDir, doc);
    return { closed, released };
  });
}
