import * as fs from "node:fs";
import { oneLine } from "../format.js";
import { appendEntry, hordePaths, requireText, writeFileAtomic } from "./files.js";
import { withHordeLock } from "./lock.js";
import { bestTextMatch, factAnchors, salientTokens, stripLeadingId } from "./text-match.js";

export interface FactEntry {
  id: number;
  text: string;
  author: string;
  deltaOf?: number | undefined;
  corroborators: string[];
  headingLine: number;
}

const FACT_LINE = /^- \[T(\d+)\] (.+?)(?:\s{2}@(\S+?))?((?:\s+\w+=[^\s]+)*)$/;

export function parseFacts(content: string): FactEntry[] {
  const facts: FactEntry[] = [];
  content.split("\n").forEach((line, lineIndex) => {
    const match = FACT_LINE.exec(line);
    if (!match) return;
    const meta = match[4] ?? "";
    const delta = /delta=#?T?(\d+)/.exec(meta);
    const corr = /corr=([^\s]+)/.exec(meta);
    facts.push({
      id: Number(match[1]),
      text: match[2] ?? "",
      author: match[3] ?? "",
      deltaOf: delta ? Number(delta[1]) : undefined,
      corroborators: corr?.[1] ? corr[1].split(",").map((s) => s.trim()).filter(Boolean) : [],
      headingLine: lineIndex,
    });
  });
  return facts;
}

/** Record a second reporter of the same fact on its heading, mirroring findings. */
function addFactCorroborator(content: string, entry: FactEntry, author: string): string {
  if (entry.author === author || entry.corroborators.includes(author)) return content;
  const lines = content.split("\n");
  const line = lines[entry.headingLine];
  if (line === undefined) return content;
  const base = line.replace(/\s+corr=[^\s]+/, "");
  lines[entry.headingLine] = `${base} corr=${[...entry.corroborators, author].join(",")}`;
  return lines.join("\n");
}

function factEntry(author: string, text: string, id: number, deltaOf?: number): string {
  const delta = deltaOf !== undefined ? `  delta=#T${deltaOf}` : "";
  return `\n- [T${id}] ${text}  @${author}${delta}\n`;
}

interface AddFactResult {
  fact: FactEntry;
  duplicateOf?: FactEntry;
  corroborationFull?: boolean;
}

const REASON_PLACEHOLDER = /\b(?:to be filled|tbd|todo|placeholder|fixme)\b|\b[0-9a-f]{6,}\.\.\.|\bxxx{2,}\b/i;

/** Reject a note that is a placeholder rather than a recorded value. */
function requireConcrete(text: string, action: string): string {
  const match = REASON_PLACEHOLDER.exec(text);
  if (match) {
    throw new Error(
      `horde: ${action} looks like a placeholder ("${match[0]}"); record the concrete value or leave it out`,
    );
  }
  return text;
}

export async function addFact(
  hordeDir: string,
  author: string,
  text: string | undefined,
  deltaOf?: number,
): Promise<AddFactResult> {
  const body = oneLine(stripLeadingId(requireText(text, "fact")), 300);
  requireConcrete(body, "fact");
  return withHordeLock(hordeDir, author, () => {
    const factsPath = hordePaths(hordeDir).facts;
    const content = fs.existsSync(factsPath) ? fs.readFileSync(factsPath, "utf-8") : "";
    const facts = parseFacts(content);
    if (deltaOf !== undefined && !facts.some((fact) => fact.id === deltaOf)) {
      throw new Error(`horde: fact T${deltaOf} does not exist; a delta must reference an existing fact`);
    }
    // A duplicate fact records the second reporter as a corroborator, the way a
    // duplicate finding does, up to one independent corroborator; a third wording
    // is dropped once the fact is already independently corroborated.
    const accrete = (hit: FactEntry): AddFactResult => {
      const corroborationFull =
        hit.author !== author && !hit.corroborators.includes(author) && hit.corroborators.length >= 1;
      if (!corroborationFull) {
        const updated = addFactCorroborator(content, hit, author);
        if (updated !== content) writeFileAtomic(factsPath, updated);
      }
      return { fact: hit, duplicateOf: hit, corroborationFull };
    };
    // Dedup applies to deltas too: a delta declared only to bypass the check would
    // otherwise record the same content again. If it is a near-duplicate of any
    // fact, including its declared parent, the reporter is accreted instead.
    const match = bestTextMatch(facts.map((fact) => fact.text), body);
    const matched = match === undefined ? undefined : facts[match.index];
    if (matched) return accrete(matched);
    // Salient-identifier dedup: facts about the same entity (host, IP, archive
    // hash, URL, bug id, date) restated from different angles are one fact.
    const anchors = factAnchors(body);
    if (anchors.size > 0) {
      const salient = salientTokens(body);
      const hit = facts.find((fact) => {
        const otherAnchors = factAnchors(fact.text);
        if (![...anchors].some((key) => otherAnchors.has(key))) return false;
        const other = salientTokens(fact.text);
        return [...salient].filter((token) => other.has(token)).length >= 2;
      });
      if (hit) return accrete(hit);
    }
    const id = facts.reduce((max, fact) => Math.max(max, fact.id), 0) + 1;
    appendEntry(factsPath, factEntry(author, body, id, deltaOf));
    return { fact: { id, text: body, author, deltaOf, corroborators: [], headingLine: -1 } };
  });
}

export function listFacts(hordeDir: string): FactEntry[] {
  const factsPath = hordePaths(hordeDir).facts;
  if (!fs.existsSync(factsPath)) return [];
  return parseFacts(fs.readFileSync(factsPath, "utf-8"));
}
