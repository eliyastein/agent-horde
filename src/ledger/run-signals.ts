import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { oneLine } from "../format.js";
import { appendEntry, boardEntry, hordePaths, requireText, writeFileAtomic } from "./files.js";
import { withHordeLock } from "./lock.js";

/** A cooperative stop request written by the parent and read by member tools. */
interface CleanStopRequest {
  runId: string;
  /** Member names, or empty for "all members". */
  members: string[];
  at: string;
}

function cleanStopPath(runDir: string): string {
  return path.join(runDir, ".stop-clean");
}

export function readCleanStop(runDir: string): CleanStopRequest | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cleanStopPath(runDir), "utf-8")) as Partial<CleanStopRequest>;
    if (typeof parsed?.runId === "string" && Array.isArray(parsed?.members)) {
      return { runId: parsed.runId, members: parsed.members, at: parsed.at ?? "" };
    }
  } catch {
    // No request, or a torn write; treat as none.
  }
  return undefined;
}

export function writeCleanStop(runDir: string, request: CleanStopRequest): void {
  writeFileAtomic(cleanStopPath(runDir), `${JSON.stringify(request)}\n`);
}

export function clearCleanStop(runDir: string): void {
  try {
    fs.unlinkSync(cleanStopPath(runDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Per-member liveness file, touched by the horde tool on every mutating action. */
function heartbeatPath(runDir: string, member: string): string {
  return path.join(runDir, `.hb-${member}`);
}

export function writeHeartbeat(runDir: string, member: string): void {
  fs.writeFileSync(heartbeatPath(runDir, member), `${new Date().toISOString()}\n`, "utf-8");
}

/** Time of the member's last ledger write, or undefined when it never wrote one. */
export function readHeartbeat(runDir: string, member: string): number | undefined {
  try {
    return fs.statSync(heartbeatPath(runDir, member)).mtimeMs;
  } catch {
    return undefined;
  }
}

export function clearHeartbeat(runDir: string, member: string): void {
  fs.rmSync(heartbeatPath(runDir, member), { force: true });
}

/** True when a clean stop covering `member` is pending for `runId`. */
export function cleanStopRequestedFor(
  hordeDir: string,
  runId: string,
  member: string,
): boolean {
  const request = readCleanStop(path.join(hordeDir, "runs", runId));
  if (!request || request.runId !== runId) return false;
  return request.members.length === 0 || request.members.includes(member);
}

/** Written by the first member that considers the run's goal answered. */
export interface SolvedSignal {
  /** Proposal revision; confirmations and contests bind to this id. */
  revision?: string;
  member: string;
  text: string;
  at: string;
  /** Revision of each finding the text cited when it was proposed, so a later amend is visible. */
  cites?: Record<string, string>;
}

function solvedPath(runDir: string): string {
  return path.join(runDir, ".solved");
}

export function answerPath(runDir: string): string {
  return path.join(runDir, "ANSWER.md");
}

/**
 * Write the run's answer as a first-class artifact that survives finalize, so the
 * full text is never reduced to a truncated board line. `status` records the
 * validation state (proposed, validated by whom, contested, or unvalidated).
 */
export function writeAnswer(
  runDir: string,
  runId: string,
  signal: SolvedSignal,
  status: string,
): void {
  const lines = [
    `# Answer - run ${runId}`,
    "",
    `Proposed by ${signal.member}${signal.at ? ` at ${signal.at}` : ""}.`,
    `Status: ${status}`,
    `Revision: ${signal.revision ?? "legacy"}`,
    "",
    signal.text.trim(),
    "",
  ];
  writeFileAtomic(answerPath(runDir), lines.join("\n"));
}

function solvedConfirmPath(runDir: string): string {
  return path.join(runDir, ".solved-confirm");
}

function solvedContestPath(runDir: string): string {
  return path.join(runDir, ".solved-contest");
}

function readSignal(file: string): SolvedSignal | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SolvedSignal>;
    if (typeof parsed?.member === "string" && typeof parsed?.text === "string") {
      const cites = parsed.cites && typeof parsed.cites === "object" ? parsed.cites : undefined;
      return { member: parsed.member, text: parsed.text, at: parsed.at ?? "", revision: parsed.revision, ...(cites ? { cites } : {}) };
    }
  } catch {
    // No signal, or a torn write; treat as none.
  }
  return undefined;
}

export function readSolved(runDir: string): SolvedSignal | undefined {
  return readSignal(solvedPath(runDir));
}

/** The two-phase solved state: the proposal plus an optional validation or refutation. */
interface SolvedState {
  proposal?: SolvedSignal | undefined;
  confirm?: SolvedSignal | undefined;
  contest?: SolvedSignal | undefined;
}

export function readSolvedState(runDir: string): SolvedState {
  return {
    proposal: readSignal(solvedPath(runDir)),
    confirm: readSignal(solvedConfirmPath(runDir)),
    contest: readSignal(solvedContestPath(runDir)),
  };
}

/** Resolve the same revision in polling and finalization. A contest always wins. */
export function resolveSolvedState(state: SolvedState): SolvedState {
  if (!state.proposal) return {};
  const matches = (signal?: SolvedSignal): boolean => Boolean(signal && signal.revision === state.proposal?.revision);
  return {
    proposal: state.proposal,
    contest: matches(state.contest) ? state.contest : undefined,
    confirm: !matches(state.contest) && matches(state.confirm) ? state.confirm : undefined,
  };
}

/** Preserve full signals before clearing transient state. Call under the horde lock. */
export function archiveSolved(runDir: string, state = readSolvedState(runDir)): void {
  if (!state.proposal) return;
  const dir = path.join(runDir, "answers");
  fs.mkdirSync(dir, { recursive: true });
  const id = state.proposal.revision ?? state.proposal.at.replace(/[^a-zA-Z0-9]/g, "");
  writeFileAtomic(path.join(dir, `${id || "legacy"}.json`), `${JSON.stringify(state, null, 2)}\n`);
}

/** Remove a proposal and its validation files (after a contest, or at finalize). */
export function clearSolved(runDir: string): void {
  for (const file of [solvedPath(runDir), solvedConfirmPath(runDir), solvedContestPath(runDir)]) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Propose that the goal is answered. The first proposal wins, but work continues
 * until a different member validates it and the parent verifies any coverage
 * requirement, or another member refutes it.
 */
export async function markSolved(
  hordeDir: string,
  runId: string,
  member: string,
  text: string | undefined,
  cites?: Record<string, string>,
): Promise<{ signal: SolvedSignal; alreadySolved: boolean }> {
  // The full answer is stored untruncated; only the board line is shortened.
  const full = requireText(text, "solved").trim();
  const line = oneLine(full, 300);
  const runDir = path.join(hordeDir, "runs", runId);
  return withHordeLock(hordeDir, member, () => {
    const existing = readSolved(runDir);
    if (existing) return { signal: existing, alreadySolved: true };
    const signal: SolvedSignal = { member, text: full, at: new Date().toISOString(), revision: randomUUID(), ...(cites ? { cites } : {}) };
    writeFileAtomic(solvedPath(runDir), `${JSON.stringify(signal)}\n`);
    // Capture the answer immediately so it survives even if the run is killed
    // before finalize; the status is upgraded on validation and at finalize.
    writeAnswer(runDir, runId, signal, "proposed; awaiting validation");
    appendEntry(hordePaths(hordeDir).board, boardEntry(member, `SOLVED proposed by ${member}: ${line}`));
    return { signal, alreadySolved: false };
  });
}

/**
 * Put a withdrawn or contested proposal back before the members, under a new revision so a
 * confirmation of the old one cannot validate it. Call under the horde lock.
 */
export function reopenSolved(runDir: string, runId: string, proposal: SolvedSignal, status: string, cites?: Record<string, string>): SolvedSignal {
  const signal: SolvedSignal = { member: proposal.member, text: proposal.text, at: new Date().toISOString(), revision: randomUUID(), ...(cites ? { cites } : {}) };
  writeFileAtomic(solvedPath(runDir), `${JSON.stringify(signal)}\n`);
  writeAnswer(runDir, runId, signal, status);
  return signal;
}

interface SolvedAnswer {
  ok: boolean;
  reason: string;
  /** The other member that confirmed or contested it, when applicable. */
  by?: string | undefined;
}

/** A different member validates the proposal; the proposer cannot validate itself. */
export async function confirmSolved(
  hordeDir: string,
  runId: string,
  member: string,
  note: string | undefined,
  revision?: string,
): Promise<SolvedAnswer> {
  const runDir = path.join(hordeDir, "runs", runId);
  return withHordeLock(hordeDir, member, () => {
    const state = readSolvedState(runDir);
    if (!state.proposal) return { ok: false, reason: "no SOLVED proposal is pending" };
    if (state.proposal.member === member) return { ok: false, reason: "the proposer cannot validate their own proposal" };
    if (revision && state.proposal.revision !== revision) return { ok: false, reason: "stale answer revision; inspect the current proposal" };
    if (state.contest) return { ok: false, reason: `the proposal was already contested by ${state.contest.member}` };
    if (state.confirm) {
      // The first confirmation credits the wind-down; later ones are still verification records.
      appendEntry(hordePaths(hordeDir).board, boardEntry(member, `also validated SOLVED: ${requireText(note, "confirm-solved")}`));
      return { ok: true, reason: "already validated", by: state.confirm.member };
    }
    const signal: SolvedSignal = {
      member,
      text: requireText(note, "confirm-solved"),
      at: new Date().toISOString(),
      revision: state.proposal.revision,
    };
    writeFileAtomic(solvedConfirmPath(runDir), `${JSON.stringify(signal)}\n`);
    if (state.proposal) writeAnswer(runDir, runId, state.proposal, `validated by ${member}`);
    appendEntry(hordePaths(hordeDir).board, boardEntry(member, `validated SOLVED: ${signal.text}`));
    return { ok: true, reason: "validated", by: member };
  });
}

/** A different member refutes the proposal; the parent clears it and work continues. */
export async function contestSolved(
  hordeDir: string,
  runId: string,
  member: string,
  note: string | undefined,
  revision?: string,
): Promise<SolvedAnswer> {
  const runDir = path.join(hordeDir, "runs", runId);
  return withHordeLock(hordeDir, member, () => {
    const state = readSolvedState(runDir);
    if (!state.proposal) return { ok: false, reason: "no SOLVED proposal is pending" };
    if (state.proposal.member === member) return { ok: false, reason: "the proposer cannot contest their own proposal" };
    if (revision && state.proposal.revision !== revision) return { ok: false, reason: "stale answer revision; inspect the current proposal" };
    const signal: SolvedSignal = {
      member,
      text: requireText(note, "contest-solved"),
      at: new Date().toISOString(),
      revision: state.proposal.revision,
    };
    writeFileAtomic(solvedContestPath(runDir), `${JSON.stringify(signal)}\n`);
    if (state.proposal) writeAnswer(runDir, runId, state.proposal, `contested by ${member}: ${signal.text}`);
    appendEntry(hordePaths(hordeDir).board, boardEntry(member, `contested SOLVED: ${signal.text}`));
    return { ok: true, reason: "contested", by: member };
  });
}
