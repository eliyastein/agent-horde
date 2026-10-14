import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_MEMBERS } from "./args.js";
import { loadCollaborationReport } from "./collaboration-report.js";
import type { CollaborationReport } from "./collaboration-report.js";
import { readEvents } from "./ledger/events.js";
import type { HordeEvent } from "./ledger/events.js";
import { listBoard } from "./ledger/board.js";
import type { BoardEntry } from "./ledger/board.js";
import { listClaims } from "./ledger/claims.js";
import type { ClaimEntry, ClaimState } from "./ledger/claims.js";
import { clusterFindings } from "./ledger/clusters.js";
import { listFacts } from "./ledger/facts.js";
import type { FactEntry } from "./ledger/facts.js";
import { hordePaths } from "./ledger/files.js";
import { collaborationState } from "./ledger/collaboration.js";
import { findingReviewState, parseFindings } from "./ledger/findings.js";
import type { FindingEntry } from "./ledger/findings.js";
import { listIdeas } from "./ledger/ideas.js";
import type { Idea } from "./ledger/ideas.js";
import { listResources } from "./ledger/resources.js";
import type { ResourceEntry } from "./ledger/resources.js";
import { buildRunGraph } from "./run-graph.js";
import type { RunGraph } from "./run-graph.js";
import { readCleanStop } from "./ledger/run-signals.js";
import { memberSessionDir, parseMemberLog } from "./member.js";
import type { MemberEndCause, MemberState, MemberStatus, MemberUsage } from "./member.js";
import { memberActivity, parseReportOutcome, parseTaskMarkdown, statusCounts, totalUsage } from "./prompt.js";
import type { RunSummaryInput, UsageTotals } from "./prompt.js";
import {
  listSessionFiles,
  memberSessionFile,
  rawSessionEntry,
  readSessionEntry,
  readSessionPage,
  sessionStats,
  SessionTooLargeError,
} from "./session-log.js";
import type { SessionFileInfo, SessionPage, SessionStats, TranscriptEntry } from "./session-log.js";

/** The in-memory run the parent exposes to the dashboard; `HordeRun` satisfies it. */
interface LiveRun extends RunSummaryInput {
  hordeDir: string;
  runDir: string;
  model?: string | undefined;
  canary?: "ok" | "failed" | undefined;
  canaryError?: string | undefined;
  startFactId: number;
  dashboardUrl?: string | undefined;
  /** Synthesis steps still running after the member slot was freed. */
  finalizing?: string[] | undefined;
}

export interface DashboardSource {
  hordeDir: string;
  getActive(): LiveRun | undefined;
  /** The run still writing DELIVERABLE.md / POSTMORTEM.md, if any. */
  getFinalizing?(): LiveRun | undefined;
  now?: () => number;
}

export class DashboardError extends Error {
  readonly status: 400 | 404 | 413;
  constructor(status: 400 | 404 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

export const RUN_ID_RE = /^\d{8}-\d{6}(?:-\d+)?$/;
export const MEMBER_RE = /^member-(\d{1,2})$/;
const SESSION_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;
export const RUN_FILES = ["TASK", "SYSTEM", "PLAN", "SUMMARY", "REPORT", "DELIVERABLE", "POSTMORTEM", "ANSWER", "ACCEPTANCE", "COLLABORATION", "GRAPH"] as const;
type RunFile = (typeof RUN_FILES)[number];

const LOG_TAIL_DEFAULT = 60;
const LOG_TAIL_MAX = 2_000;
const LOG_BYTES_MAX = 1024 * 1024;
const FILE_BYTES_MAX = 2 * 1024 * 1024;

function validRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new DashboardError(400, `invalid run id: ${runId}`);
  return runId;
}

function validMember(name: string): string {
  const match = MEMBER_RE.exec(name);
  const index = match ? Number(match[1]) : 0;
  if (index < 1 || index > MAX_MEMBERS) throw new DashboardError(400, `invalid member: ${name}`);
  return name;
}

function validRunFile(name: string): RunFile {
  if (!(RUN_FILES as readonly string[]).includes(name)) {
    throw new DashboardError(400, `unknown run file: ${name}`);
  }
  return name as RunFile;
}

function validSessionFile(name: string): string {
  if (!SESSION_FILE_RE.test(name) || path.basename(name) !== name) {
    throw new DashboardError(400, `invalid session file: ${name}`);
  }
  return name;
}

export interface CollaborationVm {
  report: CollaborationReport;
  events: HordeEvent[];
  next?: number;
  historical: boolean;
}

export function loadCollaboration(src: DashboardSource, runId: string, from = 0): CollaborationVm {
  const runDir = resolveRunDir(src, runId);
  const frozen = path.join(runDir, "ACCEPTANCE.json");
  const report = fs.existsSync(frozen) ? JSON.parse(fs.readFileSync(frozen, "utf8")).report as CollaborationReport : loadCollaborationReport(src.hordeDir, runId);
  const all = readEvents(src.hordeDir, runId);
  return { report, events: all.slice(from, from + 100), next: all.length > from + 100 ? from + 100 : undefined, historical: all.length === 0 };
}

export interface GraphView {
  /** Plot width in pixels. */
  width: number;
  /** Window as millisecond offsets from the run start; `to` 0 means the end. */
  from: number;
  to: number;
}

export interface RunGraphVm {
  runId: string;
  graph: RunGraph;
  view: GraphView;
  active: boolean;
  /** True when the run recorded no events, so the graph has only lanes. */
  empty: boolean;
}

function taskStartedAt(runDir: string): number | undefined {
  const started = parseTaskMarkdown(readOptional(path.join(runDir, "TASK.md")) ?? "").started;
  const at = started ? Date.parse(started.replace(" ", "T")) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** The run's events projected into lanes, phases, nodes, and edges, plus the requested view. */
export function loadRunGraph(src: DashboardSource, runId: string, view: GraphView): RunGraphVm {
  const runDir = runDirFor(src, runId);
  const live = activeIf(src, runId) ?? finalizingIf(src, runId);
  const events = readEvents(src.hordeDir, runId);
  const members = live
    ? live.members.map((m) => ({ name: m.name, status: m.status }))
    : memberNamesOnDisk(runDir).map((name) => ({
        name,
        status: parseMemberLog(readOptional(path.join(runDir, `${name}.log`)) ?? "").status,
      }));
  const graph = buildRunGraph({
    runId,
    events,
    members,
    startedAt: live?.startedAt ?? taskStartedAt(runDir),
    now: live ? nowOf(src) : undefined,
  });
  return { runId, graph, view, active: live !== undefined, empty: events.length === 0 };
}

function nowOf(src: DashboardSource): number {
  return src.now?.() ?? Date.now();
}

function activeIf(src: DashboardSource, runId: string): LiveRun | undefined {
  const active = src.getActive();
  return active && active.id === runId ? active : undefined;
}

function finalizingIf(src: DashboardSource, runId: string): LiveRun | undefined {
  const run = src.getFinalizing?.();
  return run && run.id === runId ? run : undefined;
}

/** Path of an existing run dir; the id is validated and the real path must stay under runs/. */
function resolveRunDir(src: DashboardSource, runId: string): string {
  validRunId(runId);
  const runs = hordePaths(src.hordeDir).runs;
  const dir = path.join(runs, runId);
  if (!fs.existsSync(dir)) throw new DashboardError(404, `no run ${runId}`);
  if (!fs.realpathSync(dir).startsWith(fs.realpathSync(runs) + path.sep)) {
    throw new DashboardError(404, `no run ${runId}`);
  }
  return dir;
}

function readOptional(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function runFilePresence(runDir: string): Record<RunFile, boolean> {
  const files = {} as Record<RunFile, boolean>;
  for (const name of RUN_FILES) files[name] = fs.existsSync(path.join(runDir, `${name}.md`));
  return files;
}

function diskOutcome(runDir: string): string | undefined {
  const report = readOptional(path.join(runDir, "REPORT.md"));
  if (report) return parseReportOutcome(report);
  return fs.existsSync(path.join(runDir, "SUMMARY.md")) ? "finished" : undefined;
}

// ---------------------------------------------------------------------------
// Run index
// ---------------------------------------------------------------------------

interface RunIndexRow {
  id: string;
  active: boolean;
  finalizing: boolean;
  started?: string | undefined;
  count?: number | undefined;
  model?: string | undefined;
  outcome?: string | undefined;
  prompt: string;
  files: Record<RunFile, boolean>;
}

export interface RunIndexVm {
  activeId?: string | undefined;
  runs: RunIndexRow[];
}

function runIndexRow(src: DashboardSource, runId: string): RunIndexRow {
  const runDir = path.join(hordePaths(src.hordeDir).runs, runId);
  const task = parseTaskMarkdown(readOptional(path.join(runDir, "TASK.md")) ?? "");
  const live = activeIf(src, runId);
  const fin = live ? undefined : finalizingIf(src, runId);
  return {
    id: runId,
    active: live !== undefined,
    finalizing: fin !== undefined,
    started: task.started,
    count: live?.count ?? task.count,
    model: live?.model ?? task.model,
    outcome: live ? liveOutcome(live) : fin ? "synthesizing" : diskOutcome(runDir),
    prompt: live?.prompt ?? task.prompt,
    files: runFilePresence(runDir),
  };
}

/** Run ids under runs/, newest first. */
function runIdsOnDisk(src: DashboardSource): string[] {
  const runs = hordePaths(src.hordeDir).runs;
  return fs.existsSync(runs) ? fs.readdirSync(runs).filter((name) => RUN_ID_RE.test(name)).sort().reverse() : [];
}

/** The run the nav's per-run links point at when the page itself names none: live first, then newest. */
export function latestRunId(src: DashboardSource): string | undefined {
  return src.getActive()?.id ?? src.getFinalizing?.()?.id ?? runIdsOnDisk(src)[0];
}

export function listRuns(src: DashboardSource): RunIndexVm {
  return { activeId: src.getActive()?.id, runs: runIdsOnDisk(src).map((id) => runIndexRow(src, id)) };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface MemberRowVm {
  name: string;
  status: MemberStatus | "unknown";
  live: boolean;
  activity: string;
  currentTool?: string | undefined;
  currentArg?: string | undefined;
  streaming?: "text" | "thinking" | undefined;
  paused: boolean;
  turns: number;
  toolCalls: number;
  usage: MemberUsage;
  elapsedMs?: number | undefined;
  endCause?: MemberEndCause | undefined;
  partial: boolean;
  /** Fresh-context resets the parent performed on this member. */
  resets: number;
  error?: string | undefined;
  exitCode?: number | undefined;
  sessionFile?: string | undefined;
}

function liveMemberRow(m: MemberState, now: number, runDir: string): MemberRowVm {
  const sessionFile = memberSessionFile(runDir, m.name);
  return {
    name: m.name,
    status: m.status,
    live: true,
    activity: memberActivity(m),
    currentTool: m.currentTool,
    currentArg: m.currentArg,
    streaming: m.streaming,
    paused: m.paused === true,
    turns: m.turns,
    toolCalls: m.toolCalls,
    usage: { ...m.usage },
    elapsedMs: (m.endedAt ?? now) - m.startedAt,
    endCause: m.endCause,
    partial: m.partial === true,
    resets: m.resets ?? 0,
    error: m.error,
    exitCode: m.exitCode,
    sessionFile: sessionFile ? path.basename(sessionFile) : undefined,
  };
}

/** Per-file stats, or undefined when the session file exceeds the size cap. */
function safeSessionStats(filePath: string): SessionStats | undefined {
  try {
    return sessionStats(filePath);
  } catch (error) {
    if (error instanceof SessionTooLargeError) return undefined;
    throw error;
  }
}

function diskMemberRow(runDir: string, name: string): MemberRowVm {
  const log = parseMemberLog(readOptional(path.join(runDir, `${name}.log`)) ?? "");
  const sessionFile = memberSessionFile(runDir, name);
  const stats = sessionFile ? safeSessionStats(sessionFile) : undefined;
  const elapsedMs =
    stats?.first && stats.last ? Date.parse(stats.last) - Date.parse(stats.first) : undefined;
  return {
    name,
    status: log.status ?? "unknown",
    live: false,
    activity: log.endCause ?? log.status ?? (log.spawnErrors[0] ?? "no log"),
    paused: false,
    turns: log.turns ?? stats?.turns ?? 0,
    toolCalls: log.toolCalls ?? stats?.toolCalls ?? 0,
    usage: stats?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    elapsedMs,
    endCause: log.endCause,
    partial: log.partial,
    resets: log.resets.length,
    error: log.spawnErrors.join("; ") || undefined,
    exitCode: log.exitCode,
    sessionFile: sessionFile ? path.basename(sessionFile) : undefined,
  };
}

function memberNamesOnDisk(runDir: string): string[] {
  if (!fs.existsSync(runDir)) return [];
  return fs
    .readdirSync(runDir)
    .map((name) => /^(member-\d+)\.log$/.exec(name)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
}

// ---------------------------------------------------------------------------
// Run overview
// ---------------------------------------------------------------------------

export interface RunOverviewVm {
  id: string;
  active: boolean;
  runDirMissing: boolean;
  prompt: string;
  model?: string | undefined;
  thinking?: string | undefined;
  count: number;
  started?: string | undefined;
  elapsedMs?: number | undefined;
  outcome?: string | undefined;
  stopLabel?: string | undefined;
  cleanStop?: { secondsLeft?: number | undefined; members: string[] } | undefined;
  plan?: string[] | undefined;
  canary?: string | undefined;
  canaryError?: string | undefined;
  diagnosis?: string | undefined;
  /** Steps still running during synthesis, shown instead of a bare outcome. */
  finalizing?: string[] | undefined;
  counts: Record<MemberStatus, number>;
  totals: UsageTotals;
  members: MemberRowVm[];
  files: Record<RunFile, boolean>;
  unmappedSessions: SessionFileInfo[];
}

function liveOutcome(live: LiveRun): string {
  if (!live.stopped) return "running";
  return live.cleanStopUntil !== undefined ? "stopping" : (live.stopLabel ?? "stopping");
}

function liveCleanStop(live: LiveRun, now: number): RunOverviewVm["cleanStop"] {
  if (live.cleanStopUntil === undefined) return undefined;
  const request = readCleanStop(live.runDir);
  return {
    secondsLeft: Math.max(0, Math.ceil((live.cleanStopUntil - now) / 1000)),
    members: request?.members ?? [],
  };
}

function liveOverview(src: DashboardSource, live: LiveRun): RunOverviewVm {
  const now = nowOf(src);
  const dirOk = fs.existsSync(live.runDir);
  const task = parseTaskMarkdown(readOptional(path.join(live.runDir, "TASK.md")) ?? "");
  const members = live.members.map((m) => liveMemberRow(m, now, live.runDir));
  return {
    id: live.id,
    active: true,
    runDirMissing: !dirOk,
    prompt: live.prompt,
    model: live.model,
    thinking: task.thinking,
    count: live.count,
    started: task.started,
    elapsedMs: now - live.startedAt,
    outcome: liveOutcome(live),
    stopLabel: live.stopLabel,
    cleanStop: liveCleanStop(live, now),
    plan: live.plan,
    canary: live.canary,
    canaryError: live.canaryError,
    diagnosis: live.diagnosis,
    counts: statusCounts(live.members),
    totals: totalUsage(live.members),
    members,
    files: dirOk ? runFilePresence(live.runDir) : runFilePresence("/nonexistent"),
    unmappedSessions: dirOk ? listSessionFiles(path.join(live.runDir, "sessions")) : [],
  };
}

function usageTotalsOf(rows: MemberRowVm[]): UsageTotals {
  return rows.reduce(
    (acc, row) => ({
      turns: acc.turns + row.turns,
      input: acc.input + row.usage.input,
      output: acc.output + row.usage.output,
      cost: acc.cost + row.usage.cost,
    }),
    { turns: 0, input: 0, output: 0, cost: 0 },
  );
}

function diskOverview(runId: string, runDir: string): RunOverviewVm {
  const task = parseTaskMarkdown(readOptional(path.join(runDir, "TASK.md")) ?? "");
  const members = memberNamesOnDisk(runDir).map((name) => diskMemberRow(runDir, name));
  const cleanStop = readCleanStop(runDir);
  const elapsed = members.map((m) => m.elapsedMs ?? 0);
  return {
    id: runId,
    active: false,
    runDirMissing: false,
    prompt: task.prompt,
    model: task.model,
    thinking: task.thinking,
    count: task.count ?? members.length,
    started: task.started,
    elapsedMs: elapsed.length > 0 ? Math.max(...elapsed) : undefined,
    outcome: diskOutcome(runDir),
    cleanStop: cleanStop ? { members: cleanStop.members } : undefined,
    plan: readOptional(path.join(runDir, "PLAN.md"))
      ?.split("\n")
      .filter((line) => line.startsWith("- layer ")),
    counts: statusCounts(members.map((m) => ({ status: m.status === "unknown" ? "failed" : m.status }))),
    totals: usageTotalsOf(members),
    members,
    files: runFilePresence(runDir),
    unmappedSessions: listSessionFiles(path.join(runDir, "sessions")),
  };
}

export function loadRunOverview(src: DashboardSource, runId: string): RunOverviewVm {
  validRunId(runId);
  const live = activeIf(src, runId);
  if (live) return liveOverview(src, live);
  const fin = finalizingIf(src, runId);
  if (fin) {
    return { ...liveOverview(src, fin), active: false, finalizing: fin.finalizing, outcome: "synthesizing" };
  }
  return diskOverview(runId, resolveRunDir(src, runId));
}

// ---------------------------------------------------------------------------
// Member detail, log, transcript
// ---------------------------------------------------------------------------

export interface MemberDetailVm extends MemberRowVm {
  runId: string;
  lastText?: string | undefined;
  finalText?: string | undefined;
  summaryIncomplete: boolean;
  logTail: string[];
  logLines: number;
}

function runDirFor(src: DashboardSource, runId: string): string {
  validRunId(runId);
  return activeIf(src, runId)?.runDir ?? resolveRunDir(src, runId);
}

function logLines(runDir: string, name: string): string[] {
  const content = readOptional(path.join(runDir, `${name}.log`)) ?? "";
  return content === "" ? [] : content.replace(/\n$/, "").split("\n");
}

export function loadMemberDetail(
  src: DashboardSource,
  runId: string,
  name: string,
  tail: number = LOG_TAIL_DEFAULT,
): MemberDetailVm {
  validMember(name);
  const runDir = runDirFor(src, runId);
  const live = activeIf(src, runId);
  const state = live?.members.find((m) => m.name === name);
  if (live && !state) throw new DashboardError(404, `run ${runId} has no ${name}`);
  if (!live && !fs.existsSync(path.join(runDir, `${name}.log`))) {
    throw new DashboardError(404, `run ${runId} has no ${name}`);
  }
  const row = state ? liveMemberRow(state, nowOf(src), runDir) : diskMemberRow(runDir, name);
  const lines = logLines(runDir, name);
  const log = parseMemberLog(lines.join("\n"));
  return {
    ...row,
    runId,
    lastText: state?.lastText || undefined,
    finalText: state?.finalText || log.final,
    summaryIncomplete: state?.summaryIncomplete === true,
    logTail: lines.slice(-Math.min(Math.max(1, tail), LOG_TAIL_MAX)),
    logLines: lines.length,
  };
}

export interface MemberLogVm {
  runId: string;
  name: string;
  lines: string[];
  total: number;
  truncated: boolean;
}

/** The member log; `tail` 0 means the whole file, capped at 2000 lines or 1 MiB. */
export function loadMemberLog(src: DashboardSource, runId: string, name: string, tail: number): MemberLogVm {
  validMember(name);
  const runDir = runDirFor(src, runId);
  const file = path.join(runDir, `${name}.log`);
  if (!fs.existsSync(file)) throw new DashboardError(404, `run ${runId} has no ${name}.log`);
  const all = logLines(runDir, name);
  const keep = tail > 0 ? Math.min(tail, LOG_TAIL_MAX) : LOG_TAIL_MAX;
  let lines = all.slice(-keep);
  let bytes = lines.join("\n").length;
  while (bytes > LOG_BYTES_MAX && lines.length > 1) {
    lines = lines.slice(Math.ceil(lines.length / 2));
    bytes = lines.join("\n").length;
  }
  return { runId, name, lines, total: all.length, truncated: lines.length < all.length };
}

export interface TranscriptVm extends SessionPage {
  runId: string;
  member?: string | undefined;
  file: string;
}

export interface TranscriptEntryVm {
  runId: string;
  member?: string | undefined;
  file: string;
  entry: TranscriptEntry;
  raw: string;
}

function guardSize<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof SessionTooLargeError) throw new DashboardError(413, error.message);
    throw error;
  }
}

function memberSessionOrThrow(src: DashboardSource, runId: string, member: string): string {
  validMember(member);
  const file = memberSessionFile(runDirFor(src, runId), member);
  if (!file) throw new DashboardError(404, `${member} of run ${runId} has no session file`);
  return file;
}

export function loadTranscript(
  src: DashboardSource,
  runId: string,
  member: string,
  from: number | "last",
  n: number,
): TranscriptVm {
  const file = memberSessionOrThrow(src, runId, member);
  const page = guardSize(() => readSessionPage(file, from, n));
  return { ...page, runId, member, file: path.basename(file) };
}

function entryVm(file: string, runId: string, member: string | undefined, index: number): TranscriptEntryVm {
  const entry = guardSize(() => readSessionEntry(file, index));
  const raw = guardSize(() => rawSessionEntry(file, index));
  if (!entry || raw === undefined) throw new DashboardError(404, `no entry ${index}`);
  return { runId, member, file: path.basename(file), entry, raw };
}

export function loadTranscriptEntry(
  src: DashboardSource,
  runId: string,
  member: string,
  index: number,
): TranscriptEntryVm {
  return entryVm(memberSessionOrThrow(src, runId, member), runId, member, index);
}

export interface SessionsVm {
  runId: string;
  files: Array<SessionFileInfo & { member?: string | undefined }>;
}

/** Every session file of a run: legacy flat files plus per-member dirs. */
export function listRunSessions(src: DashboardSource, runId: string): SessionsVm {
  const runDir = runDirFor(src, runId);
  const flat = listSessionFiles(path.join(runDir, "sessions"));
  const perMember = memberNamesOnDisk(runDir).flatMap((member) =>
    listSessionFiles(memberSessionDir(runDir, member)).map((info) => ({ ...info, member })),
  );
  return { runId, files: [...perMember, ...flat] };
}

function flatSessionOrThrow(src: DashboardSource, runId: string, fileName: string): string {
  validSessionFile(fileName);
  const file = path.join(runDirFor(src, runId), "sessions", fileName);
  if (!fs.existsSync(file)) throw new DashboardError(404, `run ${runId} has no session ${fileName}`);
  return file;
}

export function loadSessionTranscript(
  src: DashboardSource,
  runId: string,
  fileName: string,
  from: number | "last",
  n: number,
): TranscriptVm {
  const file = flatSessionOrThrow(src, runId, fileName);
  const page = guardSize(() => readSessionPage(file, from, n));
  return { ...page, runId, file: fileName };
}

export function loadSessionEntry(
  src: DashboardSource,
  runId: string,
  fileName: string,
  index: number,
): TranscriptEntryVm {
  return entryVm(flatSessionOrThrow(src, runId, fileName), runId, undefined, index);
}

// ---------------------------------------------------------------------------
// Run files
// ---------------------------------------------------------------------------

export interface FileVm {
  runId: string;
  name: RunFile;
  present: boolean;
  content: string;
  bytes: number;
  truncated: boolean;
}

export function loadRunFile(src: DashboardSource, runId: string, name: string): FileVm {
  const file = validRunFile(name);
  const content = readOptional(path.join(runDirFor(src, runId), `${file}.md`));
  if (content === undefined) return { runId, name: file, present: false, content: "", bytes: 0, truncated: false };
  const truncated = content.length > FILE_BYTES_MAX;
  return {
    runId,
    name: file,
    present: true,
    content: truncated ? content.slice(0, FILE_BYTES_MAX) : content,
    bytes: content.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Shared boards
// ---------------------------------------------------------------------------

export interface IdeasVm {
  owner?: string | undefined;
  owners: string[];
  inProgress: Idea[];
  open: Idea[];
  done: Idea[];
  ruledOut: Idea[];
}

export function loadIdeas(src: DashboardSource, owner?: string): IdeasVm {
  if (owner !== undefined && owner !== "parent") validMember(owner);
  const paths = hordePaths(src.hordeDir);
  const all = fs.existsSync(paths.ideas) ? listIdeas(src.hordeDir) : [];
  const owners = Array.from(new Set(all.map((idea) => idea.owner).filter((o): o is string => !!o))).sort();
  const ideas = owner ? all.filter((idea) => idea.owner === owner) : all;
  return {
    owner,
    owners,
    inProgress: ideas.filter((idea) => idea.mark === "~"),
    open: ideas.filter((idea) => idea.mark === " "),
    done: ideas.filter((idea) => idea.mark === "x"),
    ruledOut: ideas.filter((idea) => idea.mark === "!"),
  };
}

type RunFilter = "all" | string;

function validRunFilter(run: RunFilter): RunFilter {
  return run === "all" ? run : validRunId(run);
}

export interface BoardVm {
  run: RunFilter;
  order: "newest" | "oldest";
  runs: string[];
  entries: BoardEntry[];
}

export function loadBoard(src: DashboardSource, run: RunFilter, order: "newest" | "oldest"): BoardVm {
  validRunFilter(run);
  const all = listBoard(src.hordeDir);
  const runs = Array.from(new Set(all.map((entry) => entry.runId).filter(Boolean)));
  const entries = run === "all" ? all : all.filter((entry) => entry.runId === run);
  return { run, order, runs, entries: order === "newest" ? [...entries].reverse() : entries };
}

interface FindingClusterVm {
  representative: number;
  members: string[];
  deltaMembers: string[];
  findings: FindingEntry[];
}

export interface FindingsVm {
  run: RunFilter;
  view: "list" | "clusters";
  runs: string[];
  findings: FindingEntry[];
  clusters?: FindingClusterVm[] | undefined;
  reviewStates?: Record<number, string>;
  /** Finding ids whose bodies are shown expanded; lives in the URL so it survives auto-refresh. */
  open: number[];
}

export function loadFindings(
  src: DashboardSource,
  run: RunFilter,
  view: "list" | "clusters",
  open: number[],
): FindingsVm {
  validRunFilter(run);
  const paths = hordePaths(src.hordeDir);
  const all = fs.existsSync(paths.findings) ? parseFindings(fs.readFileSync(paths.findings, "utf-8")) : [];
  const runs = Array.from(new Set(all.map((finding) => finding.runId).filter(Boolean)));
  const findings = run === "all" ? all : all.filter((finding) => finding.runId === run);
  const clusters =
    view === "clusters"
      ? clusterFindings(findings).map((cluster) => ({
          representative: cluster.representative.id,
          members: cluster.members,
          deltaMembers: cluster.deltaMembers,
          findings: cluster.findings,
        }))
      : undefined;
  const states = new Map(runs.filter((id) => /^[\w-]+$/.test(id) && findings.some((f) => f.runId === id)).map((id) => [id, collaborationState(src.hordeDir, id)]));
  const reviewStates = Object.fromEntries(findings.map((f) => {
    const state = states.get(f.runId);
    const check = findingReviewState(f, state?.reviews, state?.messages);
    return [f.id, `${check.status}${check.reviews.length ? ` (${check.reviews.map((r) => `${r.id}:${r.support}`).join(", ")})` : ""}`];
  }));
  return { run, view, runs, findings, clusters, open, reviewStates };
}

const CLAIM_STATE_ORDER: ClaimState[] = ["open", "confirmed", "contested", "unverified", "retracted", "superseded"];

export interface ClaimsVm {
  groups: Array<{ state: ClaimState; claims: ClaimEntry[] }>;
}
export function loadClaims(src: DashboardSource): ClaimsVm {
  const paths = hordePaths(src.hordeDir);
  const all = fs.existsSync(paths.claims) ? listClaims(src.hordeDir) : [];
  return {
    groups: CLAIM_STATE_ORDER.map((state) => ({
      state,
      claims: all.filter((claim) => claim.state === state),
    })).filter((group) => group.claims.length > 0),
  };
}

export interface ResourcesVm {
  resources: ResourceEntry[];
}

/** Shared labs/harnesses/control corpora and who reused them. */
export function loadResources(src: DashboardSource): ResourcesVm {
  const paths = hordePaths(src.hordeDir);
  return { resources: fs.existsSync(paths.resources) ? listResources(src.hordeDir) : [] };
}

export interface FactsVm {
  run?: string | undefined;
  attribution: "split" | "unavailable";
  thisRun: FactEntry[];
  carried: FactEntry[];
  all: FactEntry[];
}

/** Facts split into this run / carried for the active run; other runs cannot attribute. */
export function loadFacts(src: DashboardSource, run?: string): FactsVm {
  if (run !== undefined) validRunId(run);
  const paths = hordePaths(src.hordeDir);
  const all = fs.existsSync(paths.facts) ? listFacts(src.hordeDir) : [];
  const live = run !== undefined ? activeIf(src, run) : undefined;
  if (!live) return { run, attribution: "unavailable", thisRun: [], carried: [], all };
  return {
    run,
    attribution: "split",
    thisRun: all.filter((fact) => fact.id > live.startFactId),
    carried: all.filter((fact) => fact.id <= live.startFactId),
    all,
  };
}
