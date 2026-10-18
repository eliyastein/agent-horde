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
  /** True once the parent has warned that a validated solve still has unverified findings. */
  solvedVerificationNotice?: boolean | undefined;
  solvedTimer?: ReturnType<typeof setInterval> | undefined;
  solvedCoverageNotice?: boolean | undefined;
  postmortemAbort?: AbortController | undefined;
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
  /** The run whose members are live; at most one at a time. */
  active: HordeRun | undefined;
  /** A run whose members finished but whose synthesis helpers are still running. */
  finalizing: HordeRun | undefined;
  dashboard: DashboardServer | undefined;
  /** Set synchronously at startRun entry so a same-tick second start is refused. */
  starting: boolean;
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
