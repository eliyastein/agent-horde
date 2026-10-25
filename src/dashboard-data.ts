import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_MEMBERS } from "./args.js";
import { resourceCitingMembers } from "./citations.js";
import { formatDateTime } from "./format.js";
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
import { findingReviewState, listFindingsForRun, parseFindings } from "./ledger/findings.js";
import type { FindingEntry } from "./ledger/findings.js";
import { listIdeas } from "./ledger/ideas.js";
import type { Idea } from "./ledger/ideas.js";
import { listResources } from "./ledger/resources.js";
import type { ResourceEntry } from "./ledger/resources.js";
import { buildRunGraph } from "./run-graph.js";
import { buildSwarmGraph } from "./swarm-graph.js";
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
  /** Position in the swarm and the swarm's size; a plain run is horde 1 of 1. */
  horde?: number | undefined;
  hordes?: number | undefined;
  slice?: string | undefined;
  outcome?: string | undefined;
  reported?: boolean | undefined;
  finalized?: boolean | undefined;
}

/** The in-memory swarm the parent exposes; `Swarm` satisfies it. */
export interface LiveSwarm {
  id: string;
  dir: string | undefined;
  hordes: number;
  count: number;
  prompt: string;
  startedAt: number;
  runs: LiveRun[];
  partition?: string[] | undefined;
  untilStop?: boolean | undefined;
  /** The swarm step still running after every horde finalized. */
  finalizing?: string[] | undefined;
  deliverable?: string | undefined;
}

export interface DashboardSource {
  /** The project's `.horde`; a swarm's hordes live under its `swarms/<id>/h<N>/`. */
  hordeDir: string;
  /** Runs whose members are live or whose report is not yet written. */
  getActive(): LiveRun[];
  /** Runs still writing DELIVERABLE.md / POSTMORTEM.md. */
  getFinalizing?(): LiveRun[];
  /** The swarm those runs belong to, while it is in memory. */
  getSwarm?(): LiveSwarm | undefined;
  now?: () => number;
}

export class DashboardError extends Error {
  readonly status: 400 | 404 | 413;
  constructor(status: 400 | 404 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

export const SWARM_ID_RE = /^\d{8}-\d{6}(?:-\d+)?$/;
/** A plain run id, or a swarm run id `<swarm>-h<N>`. */
export const RUN_ID_RE = /^\d{8}-\d{6}(?:-\d+)?(?:-h\d{1,2})?$/;
const SWARM_RUN_RE = /^(\d{8}-\d{6}(?:-\d+)?)-h(\d{1,2})$/;
export const MEMBER_RE = /^member-(\d{1,2})$/;
export const SWARM_FILES = ["SWARM", "REPORT", "DELIVERABLE"] as const;
type SwarmFile = (typeof SWARM_FILES)[number];

/** The swarm a run id belongs to, from its `-h<N>` suffix; undefined for a plain run. */
export function swarmOfRun(runId: string): { swarmId: string; horde: number } | undefined {
  const match = SWARM_RUN_RE.exec(runId);
  return match ? { swarmId: match[1]!, horde: Number(match[2]) } : undefined;
}

function validSwarmId(swarmId: string): string {
  if (!SWARM_ID_RE.test(swarmId)) throw new DashboardError(400, `invalid swarm id: ${swarmId}`);
  return swarmId;
}

function swarmDir(src: DashboardSource, swarmId: string): string {
  return path.join(src.hordeDir, "swarms", swarmId);
}

/** The horde directory a run's ledgers live in: the project's `.horde`, or the horde's own under `swarms/`. */
export function ledgerDir(src: DashboardSource, runId: string): string {
  const live = activeIf(src, runId) ?? finalizingIf(src, runId);
  if (live?.hordeDir) return live.hordeDir;
  const swarm = swarmOfRun(runId);
  return swarm ? path.join(swarmDir(src, swarm.swarmId), `h${swarm.horde}`) : src.hordeDir;
}

/** The ledgers a page filtered to `run` reads: that horde's for a swarm run, else the project's. */
function ledgerDirForFilter(src: DashboardSource, run: string | undefined): string {
  return run === undefined || run === "all" ? src.hordeDir : ledgerDir(src, run);
}
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
  const ledgers = ledgerDir(src, runId);
  const frozen = path.join(runDir, "ACCEPTANCE.json");
  const report = fs.existsSync(frozen) ? JSON.parse(fs.readFileSync(frozen, "utf8")).report as CollaborationReport : loadCollaborationReport(ledgers, runId);
  const all = readEvents(ledgers, runId);
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
  const events = readEvents(ledgerDir(src, runId), runId);
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
  return src.getActive().find((run) => run.id === runId);
}

function finalizingIf(src: DashboardSource, runId: string): LiveRun | undefined {
  return src.getFinalizing?.().find((run) => run.id === runId);
}

/** Path of an existing run dir; the id is validated and the real path must stay under runs/. */
function resolveRunDir(src: DashboardSource, runId: string): string {
  validRunId(runId);
  const runs = hordePaths(ledgerDir(src, runId)).runs;
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

/**
 * What a run is doing. `pending`: its directory is allocated but TASK.md is not written yet, as
 * for a swarm's hordes while the planner partitions the task. `finished`: not in memory and past
 * launch, whatever its REPORT.md says.
 */
export type RunState = "active" | "finalizing" | "pending" | "finished";

function runStateOnDisk(runDir: string): "pending" | "finished" {
  return fs.existsSync(path.join(runDir, "TASK.md")) ? "finished" : "pending";
}

function runStateOf(live: LiveRun | undefined, fin: LiveRun | undefined, runDir: string): RunState {
  if (live) return "active";
  if (fin) return "finalizing";
  return runStateOnDisk(runDir);
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
  /** The swarm this run is one horde of, when it is. */
  swarm?: string | undefined;
  state: RunState;
}

/** A swarm's state adds `not started`: the planner could not partition the task. */
export type SwarmState = RunState | "not started";

interface SwarmIndexRow {
  id: string;
  active: boolean;
  finalizing: boolean;
  state: SwarmState;
  started?: string | undefined;
  hordes: number;
  count?: number | undefined;
  prompt: string;
  /** Per-horde outcomes, `h1` first. */
  outcomes: string[];
  files: Record<SwarmFile, boolean>;
}

export interface RunIndexVm {
  activeId?: string | undefined;
  runs: RunIndexRow[];
  swarms: SwarmIndexRow[];
}

function runIndexRow(src: DashboardSource, runId: string): RunIndexRow {
  const runDir = path.join(hordePaths(ledgerDir(src, runId)).runs, runId);
  const task = parseTaskMarkdown(readOptional(path.join(runDir, "TASK.md")) ?? "");
  const live = activeIf(src, runId);
  const fin = live ? undefined : finalizingIf(src, runId);
  const state = runStateOf(live, fin, runDir);
  return {
    id: runId,
    active: live !== undefined,
    finalizing: fin !== undefined,
    state,
    started: task.started,
    count: live?.count ?? task.count,
    model: live?.model ?? task.model,
    outcome: live ? liveOutcome(live) : fin ? "synthesizing" : state === "pending" ? "pending" : diskOutcome(runDir),
    prompt: live?.prompt ?? task.prompt,
    files: runFilePresence(runDir),
    swarm: swarmOfRun(runId)?.swarmId,
  };
}

function listDir(dir: string, accept: RegExp): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => accept.test(name)).sort() : [];
}

/** Swarm ids under swarms/, newest first. */
function swarmIdsOnDisk(src: DashboardSource): string[] {
  return listDir(path.join(src.hordeDir, "swarms"), SWARM_ID_RE).reverse();
}

/** Run ids under runs/ and under every swarm's horde directories, newest first. */
function runIdsOnDisk(src: DashboardSource): string[] {
  const own = listDir(hordePaths(src.hordeDir).runs, RUN_ID_RE);
  const swarmRuns = swarmIdsOnDisk(src).flatMap((swarmId) =>
    listDir(swarmDir(src, swarmId), /^h\d{1,2}$/).flatMap((horde) =>
      listDir(hordePaths(path.join(swarmDir(src, swarmId), horde)).runs, RUN_ID_RE)));
  return [...new Set([...own, ...swarmRuns])].sort().reverse();
}

function swarmFilePresence(dir: string): Record<SwarmFile, boolean> {
  const files = {} as Record<SwarmFile, boolean>;
  for (const name of SWARM_FILES) files[name] = fs.existsSync(path.join(dir, `${name}.md`));
  return files;
}

/** A swarm's `SWARM.json`, as the parent wrote it; absent for a swarm that never started. */
interface SwarmRecordOnDisk {
  prompt?: string;
  hordes?: number;
  count?: number;
  startedAt?: number;
  untilStop?: boolean;
  partition?: string[];
  runs?: Array<{ label?: string; runId?: string; startedAt?: number; endedAt?: number; outcome?: string }>;
  merge?: { startedAt?: number; endedAt?: number; written?: boolean };
  endedAt?: number;
}

function readSwarmRecord(dir: string): SwarmRecordOnDisk | undefined {
  const raw = readOptional(path.join(dir, "SWARM.json"));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as SwarmRecordOnDisk) : undefined;
  } catch {
    return undefined;
  }
}

function liveSwarmIf(src: DashboardSource, swarmId: string): LiveSwarm | undefined {
  const swarm = src.getSwarm?.();
  return swarm && swarm.id === swarmId && swarm.dir !== undefined ? swarm : undefined;
}

function swarmRunIds(src: DashboardSource, swarmId: string, live: LiveSwarm | undefined, record: SwarmRecordOnDisk | undefined): string[] {
  if (live) return live.runs.map((run) => run.id);
  const recorded = (record?.runs ?? []).map((run) => run.runId).filter((id): id is string => typeof id === "string");
  if (recorded.length > 0) return recorded;
  return runIdsOnDisk(src).filter((id) => swarmOfRun(id)?.swarmId === swarmId).sort();
}

/**
 * A swarm is `pending` until its hordes have TASK.md (the planner is still partitioning, or the
 * parent died before launch), `not started` when the planner failed, `active` or `finalizing`
 * while in memory, and `finished` once launched and no longer in memory.
 */
function swarmStateOf(
  live: LiveSwarm | undefined,
  record: SwarmRecordOnDisk | undefined,
  notStarted: string | undefined,
  hordeStates: RunState[],
): SwarmState {
  if (notStarted !== undefined) return "not started";
  if (live) return hordeStates.includes("active") ? "active" : "finalizing";
  // `every` is true for no hordes at all, which is pending too.
  if (record === undefined || hordeStates.every((state) => state === "pending")) return "pending";
  return "finished";
}

function swarmIndexRow(src: DashboardSource, swarmId: string): SwarmIndexRow {
  const dir = swarmDir(src, swarmId);
  const live = liveSwarmIf(src, swarmId);
  const record = readSwarmRecord(dir);
  const runIds = swarmRunIds(src, swarmId, live, record);
  const rows = runIds.map((id) => runIndexRow(src, id));
  const startedAt = live?.startedAt ?? record?.startedAt;
  const notStarted = /^Not started: (.*)$/m.exec(readOptional(path.join(dir, "SWARM.md")) ?? "")?.[1];
  const active = live !== undefined && rows.some((row) => row.active);
  return {
    id: swarmId,
    active,
    finalizing: live !== undefined && !active,
    state: swarmStateOf(live, record, notStarted, rows.map((row) => row.state)),
    started: startedAt !== undefined ? formatDateTime(new Date(startedAt)) : undefined,
    hordes: live?.hordes ?? record?.hordes ?? runIds.length,
    count: live?.count ?? record?.count,
    prompt: live?.prompt ?? record?.prompt ?? (notStarted ? `not started: ${notStarted}` : ""),
    outcomes: rows.map((row) => row.outcome ?? ""),
    files: swarmFilePresence(dir),
  };
}

export function listRuns(src: DashboardSource): RunIndexVm {
  return {
    activeId: src.getActive()[0]?.id,
    runs: runIdsOnDisk(src).map((id) => runIndexRow(src, id)),
    swarms: swarmIdsOnDisk(src).map((id) => swarmIndexRow(src, id)),
  };
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
    outcome: runStateOnDisk(runDir) === "pending" ? "pending" : diskOutcome(runDir),
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

/** Throws 400 for a malformed run id and 404 for one that is neither live nor on disk. */
export function requireRun(src: DashboardSource, runId: string): void {
  runDirFor(src, runId);
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
  /** The run, or the swarm when `swarm` is set. */
  runId: string;
  name: RunFile | SwarmFile;
  present: boolean;
  content: string;
  bytes: number;
  truncated: boolean;
  swarm?: boolean | undefined;
}

function fileVm(runId: string, name: RunFile | SwarmFile, filePath: string, swarm: boolean): FileVm {
  const content = readOptional(filePath);
  const tag = swarm ? { swarm: true } : {};
  if (content === undefined) return { runId, name, present: false, content: "", bytes: 0, truncated: false, ...tag };
  const truncated = content.length > FILE_BYTES_MAX;
  return {
    runId,
    name,
    present: true,
    content: truncated ? content.slice(0, FILE_BYTES_MAX) : content,
    bytes: content.length,
    truncated,
    ...tag,
  };
}

export function loadRunFile(src: DashboardSource, runId: string, name: string): FileVm {
  const file = validRunFile(name);
  return fileVm(runId, file, path.join(runDirFor(src, runId), `${file}.md`), false);
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

/** `run` picks whose ledger to read: a swarm run's horde, else the project's. */
export function loadIdeas(src: DashboardSource, owner?: string, run?: string): IdeasVm {
  if (owner !== undefined && owner !== "parent") validMember(owner);
  if (run !== undefined) validRunId(run);
  const ledgers = ledgerDirForFilter(src, run);
  const paths = hordePaths(ledgers);
  const all = fs.existsSync(paths.ideas) ? listIdeas(ledgers) : [];
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
  entries: BoardEntry[];
}

export function loadBoard(src: DashboardSource, run: RunFilter, order: "newest" | "oldest"): BoardVm {
  validRunFilter(run);
  const all = listBoard(ledgerDirForFilter(src, run));
  const entries = run === "all" ? all : all.filter((entry) => entry.runId === run);
  return { run, order, entries: order === "newest" ? [...entries].reverse() : entries };
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
  const ledgers = ledgerDirForFilter(src, run);
  const paths = hordePaths(ledgers);
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
  const states = new Map(runs.filter((id) => /^[\w-]+$/.test(id) && findings.some((f) => f.runId === id)).map((id) => [id, collaborationState(ledgers, id)]));
  const reviewStates = Object.fromEntries(findings.map((f) => {
    const state = states.get(f.runId);
    const check = findingReviewState(f, state?.reviews, state?.messages);
    return [f.id, `${check.status}${check.reviews.length ? ` (${check.reviews.map((r) => `${r.id}:${r.support}`).join(", ")})` : ""}`];
  }));
  return { run, view, findings, clusters, open, reviewStates };
}

const CLAIM_STATE_ORDER: ClaimState[] = ["open", "confirmed", "contested", "unverified", "retracted", "superseded"];

export interface ClaimsVm {
  groups: Array<{ state: ClaimState; claims: ClaimEntry[] }>;
}
export function loadClaims(src: DashboardSource, run?: string): ClaimsVm {
  if (run !== undefined) validRunId(run);
  const ledgers = ledgerDirForFilter(src, run);
  const paths = hordePaths(ledgers);
  const all = fs.existsSync(paths.claims) ? listClaims(ledgers) : [];
  return {
    groups: CLAIM_STATE_ORDER.map((state) => ({
      state,
      claims: all.filter((claim) => claim.state === state),
    })).filter((group) => group.claims.length > 0),
  };
}

export interface ResourcesVm {
  /** The active run whose findings, evidence, reviews and leases were scanned for citations. */
  run?: string | undefined;
  resources: Array<ResourceEntry & { citedBy: string[] }>;
}

/**
 * Shared labs/harnesses/control corpora, who reclaimed them, and who cited them. Citations are
 * counted the way REPORT.md counts them, from the active run's ledgers; without an active run
 * only explicit reclaims are known.
 */
export function loadResources(src: DashboardSource, run?: string): ResourcesVm {
  if (run !== undefined) validRunId(run);
  const ledgers = ledgerDirForFilter(src, run);
  const paths = hordePaths(ledgers);
  const resources = fs.existsSync(paths.resources) ? listResources(ledgers) : [];
  const live = run !== undefined ? activeIf(src, run) : src.getActive().find((candidate) => candidate.hordeDir === ledgers);
  const citing = live
    ? resourceCitingMembers(resources, listFindingsForRun(live.hordeDir, live.id), collaborationState(live.hordeDir, live.id))
    : new Map<number, string[]>();
  return { run: live?.id, resources: resources.map((resource) => ({ ...resource, citedBy: citing.get(resource.id) ?? [] })) };
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
  const ledgers = ledgerDirForFilter(src, run);
  const paths = hordePaths(ledgers);
  const all = fs.existsSync(paths.facts) ? listFacts(ledgers) : [];
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

// ---------------------------------------------------------------------------
// Swarms
// ---------------------------------------------------------------------------

export interface SwarmHordeVm {
  label: string;
  runId: string;
  active: boolean;
  finalizing: boolean;
  state: RunState;
  outcome?: string | undefined;
  slice?: string | undefined;
  count: number;
  counts: Record<MemberStatus, number>;
  totals: UsageTotals;
  findings: number;
  acceptedArtifacts: number;
  elapsedMs?: number | undefined;
  files: Record<RunFile, boolean>;
}

export interface SwarmVm {
  id: string;
  active: boolean;
  finalizing: boolean;
  state: SwarmState;
  notStarted?: string | undefined;
  prompt: string;
  hordes: number;
  count?: number | undefined;
  started?: string | undefined;
  elapsedMs?: number | undefined;
  untilStop: boolean;
  partition: string[];
  /** What the merge step is doing or did: "pending", "merging", "merged", "no deliverable". */
  merge: string;
  rows: SwarmHordeVm[];
  files: Record<SwarmFile, boolean>;
}

function acceptedArtifactCount(runDir: string): number {
  const raw = readOptional(path.join(runDir, "ACCEPTANCE.json"));
  if (raw === undefined) return 0;
  try {
    const accepted = (JSON.parse(raw) as { report?: { acceptedArtifacts?: unknown[] } }).report?.acceptedArtifacts;
    return Array.isArray(accepted) ? accepted.length : 0;
  } catch {
    return 0;
  }
}

function swarmHordeVm(src: DashboardSource, runId: string, slice: string | undefined): SwarmHordeVm {
  const overview = loadRunOverview(src, runId);
  const ledgers = ledgerDir(src, runId);
  const runDir = path.join(hordePaths(ledgers).runs, runId);
  let findings = 0;
  try {
    findings = listFindingsForRun(ledgers, runId).length;
  } catch {
    // A horde whose FINDINGS.md is unreadable reports none.
  }
  const finalizing = (overview.finalizing?.length ?? 0) > 0;
  return {
    label: `h${swarmOfRun(runId)?.horde ?? "?"}`,
    runId,
    active: overview.active,
    finalizing,
    state: overview.active ? "active" : finalizing ? "finalizing" : runStateOnDisk(runDir),
    outcome: overview.outcome,
    slice,
    count: overview.count,
    counts: overview.counts,
    totals: overview.totals,
    findings,
    acceptedArtifacts: acceptedArtifactCount(runDir),
    elapsedMs: overview.elapsedMs,
    files: overview.files,
  };
}

function mergeLabel(live: LiveSwarm | undefined, record: SwarmRecordOnDisk | undefined, rows: SwarmHordeVm[]): string {
  if (live?.finalizing?.length) return "merging";
  const merge = record?.merge;
  if (merge?.endedAt !== undefined) return merge.written === false ? "no deliverable" : "merged";
  if (merge?.startedAt !== undefined) return "merging";
  return rows.every((row) => !row.active && !row.finalizing) && !live ? "not run" : "pending";
}

/** One row per horde, linking to the run pages, plus the partition and the merge step. */
export function loadSwarm(src: DashboardSource, swarmId: string): SwarmVm {
  validSwarmId(swarmId);
  const dir = swarmDir(src, swarmId);
  const live = liveSwarmIf(src, swarmId);
  if (!live && !fs.existsSync(dir)) throw new DashboardError(404, `no swarm ${swarmId}`);
  const record = readSwarmRecord(dir);
  const partition = live?.partition ?? record?.partition ?? [];
  const rows = swarmRunIds(src, swarmId, live, record).map((runId, index) => swarmHordeVm(src, runId, partition[index]));
  const startedAt = live?.startedAt ?? record?.startedAt;
  const endedAt = live ? undefined : record?.endedAt;
  const notStarted = /^Not started: (.*)$/m.exec(readOptional(path.join(dir, "SWARM.md")) ?? "")?.[1];
  const active = live !== undefined && rows.some((row) => row.active);
  return {
    id: swarmId,
    active,
    finalizing: live !== undefined && !active,
    state: swarmStateOf(live, record, notStarted, rows.map((row) => row.state)),
    notStarted,
    prompt: live?.prompt ?? record?.prompt ?? "",
    hordes: live?.hordes ?? record?.hordes ?? rows.length,
    count: live?.count ?? record?.count,
    started: startedAt !== undefined ? formatDateTime(new Date(startedAt)) : undefined,
    elapsedMs: startedAt !== undefined ? (endedAt ?? nowOf(src)) - startedAt : undefined,
    untilStop: live?.untilStop === true || record?.untilStop === true,
    partition,
    merge: mergeLabel(live, record, rows),
    rows,
    files: swarmFilePresence(dir),
  };
}

/** One horde of a swarm: its tab label and its run. */
export interface SwarmHorde {
  label: string;
  runId: string;
}

/** The swarm's hordes in order, `h1` first; throws when the swarm does not exist. */
export function swarmHordes(src: DashboardSource, swarmId: string): SwarmHorde[] {
  validSwarmId(swarmId);
  const live = liveSwarmIf(src, swarmId);
  if (!live && !fs.existsSync(swarmDir(src, swarmId))) throw new DashboardError(404, `no swarm ${swarmId}`);
  const runIds = swarmRunIds(src, swarmId, live, readSwarmRecord(swarmDir(src, swarmId)));
  return runIds.map((runId) => ({ label: `h${swarmOfRun(runId)?.horde ?? "?"}`, runId }));
}

/** A ledger page aggregated across a swarm: one section per horde, each the normal per-horde view. */
export interface SwarmLedgerVm<T> {
  swarmId: string;
  sections: Array<SwarmHorde & { vm: T }>;
}

function swarmSections<T>(src: DashboardSource, swarmId: string, perHorde: (runId: string) => T): SwarmLedgerVm<T> {
  return { swarmId, sections: swarmHordes(src, swarmId).map((l) => ({ ...l, vm: perHorde(l.runId) })) };
}

/** Each horde's collaboration state on one page; the event audit stays on the horde's own page. */
export function loadSwarmCollaboration(src: DashboardSource, swarmId: string): SwarmLedgerVm<CollaborationVm> {
  return swarmSections(src, swarmId, (runId) => loadCollaboration(src, runId));
}

export function loadSwarmIdeas(src: DashboardSource, swarmId: string, owner?: string): SwarmLedgerVm<IdeasVm> {
  return swarmSections(src, swarmId, (runId) => loadIdeas(src, owner, runId));
}

export function loadSwarmBoard(src: DashboardSource, swarmId: string, order: "newest" | "oldest"): SwarmLedgerVm<BoardVm> {
  return swarmSections(src, swarmId, (runId) => loadBoard(src, runId, order));
}

export function loadSwarmFindings(src: DashboardSource, swarmId: string, view: "list" | "clusters", open: number[]): SwarmLedgerVm<FindingsVm> {
  return swarmSections(src, swarmId, (runId) => loadFindings(src, runId, view, open));
}

export function loadSwarmClaims(src: DashboardSource, swarmId: string): SwarmLedgerVm<ClaimsVm> {
  return swarmSections(src, swarmId, (runId) => loadClaims(src, runId));
}

export function loadSwarmFacts(src: DashboardSource, swarmId: string): SwarmLedgerVm<FactsVm> {
  return swarmSections(src, swarmId, (runId) => loadFacts(src, runId));
}

export function loadSwarmResources(src: DashboardSource, swarmId: string): SwarmLedgerVm<ResourcesVm> {
  return swarmSections(src, swarmId, (runId) => loadResources(src, runId));
}

export interface SwarmGraphVm {
  swarmId: string;
  graph: RunGraph;
  view: GraphView;
  active: boolean;
  empty: boolean;
}

/** One lane per horde built from each horde's lifecycle events, plus the merge step. */
export function loadSwarmGraph(src: DashboardSource, swarmId: string, view: GraphView): SwarmGraphVm {
  validSwarmId(swarmId);
  const dir = swarmDir(src, swarmId);
  const live = liveSwarmIf(src, swarmId);
  if (!live && !fs.existsSync(dir)) throw new DashboardError(404, `no swarm ${swarmId}`);
  const record = readSwarmRecord(dir);
  const runIds = swarmRunIds(src, swarmId, live, record);
  const hordes = runIds.map((runId) => {
    const run = activeIf(src, runId) ?? finalizingIf(src, runId);
    const status = run ? (run.finalized ? "finished" : run.reported ? "finalizing" : "running") : diskOutcome(path.join(hordePaths(ledgerDir(src, runId)).runs, runId));
    return { label: `h${swarmOfRun(runId)?.horde ?? "?"}`, runId, events: readEvents(ledgerDir(src, runId), runId), status };
  });
  const merge = record?.merge?.startedAt !== undefined
    ? { startedAt: record.merge.startedAt, endedAt: record.merge.endedAt, written: record.merge.written }
    : undefined;
  const graph = buildSwarmGraph({
    swarmId,
    startedAt: live?.startedAt ?? record?.startedAt ?? Math.min(...hordes.map((h) => Date.parse(h.events[0]?.at ?? "")).filter(Number.isFinite), Date.now()),
    hordes,
    merge,
    now: live ? nowOf(src) : undefined,
  });
  return { swarmId, graph, view, active: live !== undefined, empty: hordes.every((horde) => horde.events.length === 0) };
}

export function loadSwarmFile(src: DashboardSource, swarmId: string, name: string): FileVm {
  validSwarmId(swarmId);
  if (!(SWARM_FILES as readonly string[]).includes(name)) throw new DashboardError(400, `unknown swarm file: ${name}`);
  const dir = swarmDir(src, swarmId);
  if (!fs.existsSync(dir)) throw new DashboardError(404, `no swarm ${swarmId}`);
  return fileVm(swarmId, name as SwarmFile, path.join(dir, `${name}.md`), true);
}
