import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { DashboardServer } from "../dashboard.js";
import type { SolvedSignal } from "../ledger/run-signals.js";
import type { MemberReset, MemberRunInfo, MemberState } from "../member.js";

export interface HordeRun extends MemberRunInfo {
  members: MemberState[];
  controller: AbortController;
  controllers: Map<string, AbortController>;
  procs: Map<string, ChildProcess>;
  cwd: string;
  /** 1-based position in the swarm; the horde is addressed as `h<N>`. */
  horde: number;
  /** The horde's workstream when the swarm partitioned the task; every member sees it. */
  slice?: string | undefined;
  /** Highest fact id at run start, to separate this run's facts from carried context. */
  startFactId: number;
  /** Highest idea id at run start; ideas created above it are this run's coverage. */
  startIdeaId: number;
  startedAt: number;
  stopped: boolean;
  /** Members asked to wrap up by stop-clean; their ideas are released at finalize. */
  cleanStopNames: string[];
  cleanStopUntil?: number | undefined;
  cleanStopTimer?: ReturnType<typeof setTimeout> | undefined;
  cleanStopExtended?: boolean | undefined;
  /** True once the stop granted its one-time window for a late solve to be validated. */
  solvedStopExtended?: boolean | undefined;
  /** Model used for the run, for the generated report. */
  model?: string | undefined;
  canary?: "ok" | "failed" | undefined;
  canaryError?: string | undefined;
  diagnosis?: string | undefined;
  acceptance?: string;
  snapshotHash?: string;
  repairTokens?: number;
  /** Members whose queued repair work was skipped because the budget could not fund an attempt. */
  repairSkipped?: string[];
  /** True when a user command or session shutdown ended the run. */
  userStop?: boolean | undefined;
  /** Human-readable stop reason for the report, e.g. "stopped by user". */
  stopLabel?: string | undefined;
  /** True when stop-clean asked for a post-mortem. */
  postmortemFlag?: boolean | undefined;
  /** Generated post-mortem markdown, appended to the report. */
  postmortem?: string | undefined;
  /** Generated merged task deliverable markdown. */
  deliverable?: string | undefined;
  deliverableAbort?: AbortController | undefined;
  /** Steps still running after members finished, e.g. ["deliverable", "post-mortem"]. */
  finalizing?: string[] | undefined;
  /** The run's outcome label once REPORT.md is written, e.g. "solved" or "stopped-clean". */
  outcome?: string | undefined;
  /** True once members exited and REPORT.md is written; the swarm slot frees when every run is. */
  reported?: boolean | undefined;
  /** True once finalize completed, synthesis included. */
  finalized?: boolean | undefined;
  /** Workstream partition when the run was started with `plan`. */
  plan?: string[] | undefined;
  /** Member carrying the verifier role, when one was assigned. */
  verifier?: string | undefined;
  /** Fresh-context resets performed during the run, oldest first. */
  resets: MemberReset[];
  stallTimer?: ReturnType<typeof setInterval> | undefined;
  /** Assigns artifact reviews and dependency repins during discovery. */
  scheduleTimer?: ReturnType<typeof setInterval> | undefined;
  /** URL of the localhost dashboard when the run was started with `--dashboard`. */
  dashboardUrl?: string | undefined;
  deadlineTimer?: ReturnType<typeof setTimeout> | undefined;
  /** Set when a member reported the goal answered; the parent winds the run down. */
  solved?: SolvedSignal | undefined;
  /** Peer confirmation of the current proposal, independent of final acceptance. */
  solvedValidatedBy?: string | undefined;
  /** True once the parent wound the run down on the validated proposal. */
  solvedCommitted?: boolean | undefined;
  /** True when the last SOLVED proposal was contested and no validated answer replaced it. */
  solvedContested?: boolean | undefined;
  /** The contested proposal and the idea ids its contest named; it reopens once they all close. */
  solvedContest?: { proposal: SolvedSignal; blockers: number[] } | undefined;
  /** True once the parent has warned that a validated solve still has unverified findings. */
  solvedVerificationNotice?: boolean | undefined;
  /** Solves banked so far in an `--until-stop` run. */
  solveRounds?: number | undefined;
  /** The latest banked solve of an `--until-stop` run: the answer unless a later proposal is validated. */
  lastRound?: { proposal: SolvedSignal; validator: string | undefined } | undefined;
  solvedTimer?: ReturnType<typeof setInterval> | undefined;
  solvedCoverageNotice?: boolean | undefined;
  postmortemAbort?: AbortController | undefined;
  ui?: ExtensionUIContext;
}

/**
 * H concurrent hordes on one task. A plain `12` is a swarm of one whose run lives in
 * `.horde/runs/`; `3/12` gives each horde its own ledgers under `.horde/swarms/<id>/h<N>/`.
 */
export interface Swarm {
  id: string;
  /** `.horde/swarms/<id>`; undefined for a swarm of one. */
  dir: string | undefined;
  /** The project's `.horde` directory. */
  hordeDir: string;
  cwd: string;
  prompt: string;
  hordes: number;
  /** Members per horde. */
  count: number;
  startedAt: number;
  /** One run per horde, `h1` first. */
  runs: HordeRun[];
  /** The `plan` layers as given, before they were dealt to the hordes. */
  plan?: string[] | undefined;
  /** Per-horde workstream, indexed by horde - 1; absent for a swarm of one. */
  partition?: string[] | undefined;
  untilStop?: boolean | undefined;
  dashboardUrl?: string | undefined;
  /** Generated merged deliverable across the hordes' deliverables. */
  deliverable?: string | undefined;
  deliverableAbort?: AbortController | undefined;
  /** The swarm step still running after every horde finalized, e.g. ["merge"]. */
  finalizing?: string[] | undefined;
  ui?: ExtensionUIContext;
  tui?: TUI;
  timer?: ReturnType<typeof setInterval> | undefined;
}

export interface ReportDetails {
  runId: string;
  elapsedMs: number;
  stopped: boolean;
  diagnosis?: string | undefined;
  postmortem?: string | undefined;
  deliverable?: string | undefined;
  members: Array<Pick<MemberState, "name" | "status" | "turns" | "error"> & { tokens: number }>;
}

/** Parent-side extension state shared by the command, run lifecycle, and shutdown. */
export interface HordeState {
  pi: ExtensionAPI;
  /** The swarm whose members are live; at most one at a time. */
  active: Swarm | undefined;
  /** A swarm whose members finished but whose synthesis helpers are still running. */
  finalizing: Swarm | undefined;
  dashboard: DashboardServer | undefined;
  /** Set synchronously at startSwarm entry so a same-tick second start is refused. */
  starting: boolean;
  /** The planner partitioning a task between hordes, so shutdown can end it. */
  plannerAbort?: AbortController | undefined;
  /** Set at session shutdown; lifecycle steps check it and stop early. */
  disposed: boolean;
}

export function createHordeState(pi: ExtensionAPI): HordeState {
  return {
    pi,
    active: undefined,
    finalizing: undefined,
    dashboard: undefined,
    starting: false,
    disposed: false,
  };
}

/** `h2` for the second horde; the label every notification, target, and file uses. */
export function hordeLabel(horde: number): string {
  return `h${horde}`;
}

/** Runs of the swarm whose members are not all finished and reported. */
export function activeRuns(swarm: Swarm): HordeRun[] {
  return swarm.runs.filter((run) => run.reported !== true);
}

/** Runs of the swarm whose members finished but whose synthesis is still running. */
export function finalizingRuns(swarm: Swarm): HordeRun[] {
  return swarm.runs.filter((run) => run.reported === true && run.finalized !== true);
}
