import * as fs from "node:fs";
import { oneLine } from "../format.js";
import { hordePaths, requireText, writeFileAtomic } from "./files.js";
import { withHordeLock } from "./lock.js";

export type ClaimState =
  | "open"
  | "confirmed"
  | "contested"
  | "retracted"
  | "superseded"
  | "unverified";

export interface ClaimEntry {
  id: number;
  state: ClaimState;
  statement: string;
  owner: string;
  notes: string[];
}

interface ClaimsDoc {
  lines: string[];
  claims: Map<number, { index: number; claim: ClaimEntry }>;
}

const CLAIM_LINE = /^- \[(\w+)\] C(\d+) (.+?)(?:\s{2}@(\S+?))?(?:\s{2}notes: (.*))?$/;

const CLAIM_STATES = new Set<ClaimState>([
  "open",
  "confirmed",
  "contested",
  "retracted",
  "superseded",
  "unverified",
]);

function parseClaimsDoc(content: string): ClaimsDoc {
  const lines = content.split("\n");
  const claims = new Map<number, { index: number; claim: ClaimEntry }>();
  lines.forEach((line, index) => {
    const match = CLAIM_LINE.exec(line);
    if (!match) return;
    const state = (match[1] ?? "open") as ClaimState;
    claims.set(Number(match[2]), {
      index,
      claim: {
        id: Number(match[2]),
        state: CLAIM_STATES.has(state) ? state : "open",
        statement: match[3] ?? "",
        owner: match[4] ?? "",
        notes: match[5] ? match[5].split(" | ").map((note) => note.trim()).filter(Boolean) : [],
      },
    });
  });
  return { lines, claims };
}

function formatClaim(claim: ClaimEntry): string {
  let line = `- [${claim.state}] C${claim.id} ${claim.statement}`;
  if (claim.owner) line += `  @${claim.owner}`;
  if (claim.notes.length > 0) line += `  notes: ${claim.notes.join(" | ")}`;
  return line;
}

function readClaimsDoc(hordeDir: string): ClaimsDoc {
  return parseClaimsDoc(fs.readFileSync(hordePaths(hordeDir).claims, "utf-8"));
}

function writeClaimsDoc(hordeDir: string, doc: ClaimsDoc): void {
  writeFileAtomic(hordePaths(hordeDir).claims, doc.lines.join("\n"));
}

function requireClaim(doc: ClaimsDoc, id: number): { index: number; claim: ClaimEntry } {
  const entry = doc.claims.get(id);
  if (!entry) throw new Error(`horde: claim C${id} does not exist; read CLAIMS.md for current ids`);
  return entry;
}

export async function assertClaim(
  hordeDir: string,
  author: string,
  text: string | undefined,
): Promise<ClaimEntry> {
  const statement = oneLine(requireText(text, "assert"), Infinity);
  return withHordeLock(hordeDir, author, () => {
    const doc = readClaimsDoc(hordeDir);
    const id = [...doc.claims.keys()].reduce((max, value) => Math.max(max, value), 0) + 1;
    const claim: ClaimEntry = { id, state: "open", statement, owner: author, notes: [] };
    if (doc.lines.length > 0 && doc.lines[doc.lines.length - 1] === "") doc.lines.pop();
    doc.lines.push(formatClaim(claim), "");
    writeClaimsDoc(hordeDir, doc);
    return claim;
  });
}

async function setClaimState(  hordeDir: string,
  author: string,
  id: number,
  state: ClaimState,
  note: string | undefined,
): Promise<ClaimEntry> {
  const noteText = `${new Date().toISOString()} @${author}: ${oneLine(note ?? "", Infinity) || state}`;
  return withHordeLock(hordeDir, author, () => {
    const doc = readClaimsDoc(hordeDir);
    const { index, claim } = requireClaim(doc, id);
    const updated: ClaimEntry = {
      ...claim,
      state,
      notes: [...claim.notes, noteText],
    };
    doc.lines[index] = formatClaim(updated);
    writeClaimsDoc(hordeDir, doc);
    return updated;
  });
}

export function confirmClaim(hordeDir: string, author: string, id: number, note?: string) {
  return setClaimState(hordeDir, author, id, "confirmed", note);
}

export function contestClaim(hordeDir: string, author: string, id: number, note?: string) {
  return setClaimState(hordeDir, author, id, "contested", note);
}

export function retractClaim(hordeDir: string, author: string, id: number, note?: string) {
  return setClaimState(hordeDir, author, id, "retracted", note);
}

export async function supersedeClaim(
  hordeDir: string,
  author: string,
  id: number,
  text: string | undefined,
): Promise<ClaimEntry> {
  const raw = oneLine(text ?? "", Infinity);
  const match = /^(?:C)?(\d+)\b\s*(.*)$/.exec(raw);
  const by = match ? `C${match[1]}` : "a later claim";
  const reason = match?.[2] ?? raw;
  const note = `${by} supersedes it${reason ? `: ${reason}` : ""}`;
  return setClaimState(hordeDir, author, id, "superseded", note);
}

/** Mark claims owned by terminated members as unverified so stale positions cannot read as truth. */
export async function markClaimsUnverified(
  hordeDir: string,
  owners: Array<{ name: string; cause: string }>,
): Promise<number[]> {
  if (owners.length === 0) return [];
  const byOwner = new Map(owners.map((owner) => [owner.name, owner.cause]));
  return withHordeLock(hordeDir, "parent", () => {
    const doc = readClaimsDoc(hordeDir);
    const changed: number[] = [];
    for (const { index, claim } of doc.claims.values()) {
      if ((claim.state === "open" || claim.state === "confirmed") && byOwner.has(claim.owner)) {
        const updated: ClaimEntry = {
          ...claim,
          state: "unverified",
          notes: [...claim.notes, `owner ${claim.owner} ended: ${byOwner.get(claim.owner)}`],
        };
        doc.lines[index] = formatClaim(updated);
        changed.push(claim.id);
      }
    }
    if (changed.length > 0) writeClaimsDoc(hordeDir, doc);
    return changed;
  });
}

export function listClaims(hordeDir: string): ClaimEntry[] {
  return [...readClaimsDoc(hordeDir).claims.values()]
    .map((entry) => entry.claim)
    .sort((a, b) => a.id - b.id);
}
