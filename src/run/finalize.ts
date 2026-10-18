import * as fs from "node:fs";
import * as path from "node:path";
import {
  generatedArtifactWarnings,
  ledgerCitationWarnings,
  reportConsistencyWarnings,
  resourceCitations,
  resourceCitingMembers,
} from "../citations.js";
import { errorMessage, oneLine } from "../format.js";
import { freezeAcceptance } from "../collaboration-report.js";
import { lastBoardPostsByMember, lateBoardPosts, postBoard } from "../ledger/board.js";
import { listClaims, markClaimsUnverified } from "../ledger/claims.js";
import type { ClaimEntry } from "../ledger/claims.js";
import { collaborationState } from "../ledger/collaboration.js";
import { readEvents } from "../ledger/events.js";
import { clusterFindings } from "../ledger/clusters.js";
import { listFacts } from "../ledger/facts.js";
import type { FactEntry } from "../ledger/facts.js";
import { readHordeFile } from "../ledger/files.js";
import { listFindingsForRun, parseFindings } from "../ledger/findings.js";
import type { FindingEntry } from "../ledger/findings.js";
import { countIdeas, parseIdeas, reconcileOwnedIdeas } from "../ledger/ideas.js";
import type { Idea } from "../ledger/ideas.js";
import { listResources, pendingCleanups, readRunResources } from "../ledger/resources.js";
import type { PendingCleanup } from "../ledger/resources.js";
import { archiveSolved, clearCleanStop, clearSolved, readSolvedState, resolveSolvedState, writeAnswer } from "../ledger/run-signals.js";
import type { SolvedSignal } from "../ledger/run-signals.js";
import { childEnv, execPi } from "../member.js";
import { reportText, runReportMarkdown, summaryMarkdown } from "../prompt.js";
import { buildRunGraph } from "../run-graph.js";
import { runGraphMarkdown } from "../run-graph-mermaid.js";
import type { CleanupStatus, ReportResource, RunReportInput } from "../prompt.js";
import { buildDiagnosis } from "./diagnosis.js";
import { recordLifecycle, recordPhase } from "./lifecycle.js";
import { runDeliverable, runPostmortem } from "./synthesis.js";
import type { HordeRun, HordeState } from "./types.js";
import { REPORT_TYPE, refreshRun, reportDetails, safeNotify, unmountWidget } from "./ui.js";

/** Most deliverable warnings shown inline; REPORT.md keeps the full list. */
const INLINE_WARNING_CAP = 12;

/** The ledger state a finished run is reported from. */
interface RunLedgers {
  ideaCounts: { open: number; inProgress: number; done: number };
  ideas: Idea[];
  findings: FindingEntry[];
  claims: ClaimEntry[];
  facts: FactEntry[];
  /** Resources this run claimed or reused, with the non-owners whose records cite each one. */
  resources: ReportResource[];
}

type CleanupResult = NonNullable<RunReportInput["cleanups"]>[number];

/** The report input, with the warning list the synthesis step appends to. */
type RunReport = RunReportInput & { consistencyWarnings: string[] };

/** Cancel every run timer; used at finalize and at session shutdown. */
export function stopRunTimers(run: HordeRun): void {
  if (run.cleanStopTimer) clearTimeout(run.cleanStopTimer);
  run.cleanStopTimer = undefined;
  run.cleanStopUntil = undefined;
  if (run.deadlineTimer) clearTimeout(run.deadlineTimer);
  run.deadlineTimer = undefined;
  if (run.solvedTimer) clearInterval(run.solvedTimer);
  run.solvedTimer = undefined;
  if (run.stallTimer) clearInterval(run.stallTimer);
  run.stallTimer = undefined;
  if (run.scheduleTimer) clearInterval(run.scheduleTimer);
  run.scheduleTimer = undefined;
}

/** Write a run file, reporting (not throwing) a failure so finalize keeps going. */
function writeRunFile(run: HordeRun, name: string, content: string): void {
  try {
    fs.writeFileSync(path.join(run.runDir, name), content, "utf-8");
  } catch (error) {
    safeNotify(run, `horde ${run.id}: could not write ${name} (${errorMessage(error)})`, "error");
  }
}

/**
 * Settle the goal-solved state from the signal files, then write the answer
 * artifact with its validation status before the sentinel files are cleared.
 */
function settleSolved(run: HordeRun): SettledAnswer | undefined {
  const rawState = readSolvedState(run.runDir);
  const solvedState = resolveSolvedState(rawState);
  archiveSolved(run.runDir, rawState);
  if (solvedState.contest && solvedState.proposal) {
    const status = `contested by ${solvedState.contest.member}: ${solvedState.contest.text}`;
    writeAnswer(run.runDir, run.id, solvedState.proposal, status);
    run.solved = undefined;
    run.solvedValidatedBy = undefined;
    run.solvedContested = true;
    clearSolved(run.runDir);
    clearCleanStop(run.runDir);
    return { proposal: solvedState.proposal, status };
  }
  if (!run.solved) run.solved = solvedState.proposal;
  if (
    run.solved &&
    !run.solvedValidatedBy &&
    solvedState.confirm &&
    solvedState.confirm.member !== run.solved.member
  ) {
    run.solvedValidatedBy = solvedState.confirm.member;
  }
  if (run.solved) {
    const status = run.solvedValidatedBy
      ? `validated by ${run.solvedValidatedBy}`
      : "unvalidated (no independent confirmation)";
    try {
      writeAnswer(run.runDir, run.id, run.solved, status);
    } catch (error) {
      safeNotify(run, `horde ${run.id}: could not write ANSWER.md (${errorMessage(error)})`, "error");
    }
  }
  clearSolved(run.runDir);
  clearCleanStop(run.runDir);
  if (!run.solved) return undefined;
  const confirmation = run.solvedValidatedBy ? `peer-confirmed by ${run.solvedValidatedBy}` : "no independent confirmation";
  return { proposal: run.solved, status: confirmation };
}

interface SettledAnswer {
  proposal: SolvedSignal;
  status: string;
}

/**
 * The proposal body is the member's verbatim text and can predate later challenges. When acceptance
 * fails, the status names the blockers still open at freeze and, once synthesis wrote it, points
 * the operator at DELIVERABLE.md as the reconciled output.
 */
function annotateAnswer(run: HordeRun, answer: SettledAnswer, acceptance: { hash: string; issues: string[] }): void {
  const blockers = acceptance.issues.filter((issue) => /^Q\d+ .*: \w+ blocking /.test(issue)).map((issue) => issue.replace(/:/, ""));
  const parts = [answer.status, "acceptance incomplete"];
  if (blockers.length) parts.push(`open blocking at freeze: ${blockers.join(", ")}`);
  parts.push(`see ACCEPTANCE.md (snapshot ${acceptance.hash})`);
  if (run.deliverable) parts.push("reconciled operator output: DELIVERABLE.md; the proposal text below is verbatim and may be superseded there");
  try {
    writeAnswer(run.runDir, run.id, answer.proposal, parts.join("; "));
  } catch (error) {
    safeNotify(run, `horde ${run.id}: could not write ANSWER.md (${errorMessage(error)})`, "error");
  }
}

/**
 * Close or release in-progress ideas owned by any member of this run, so a
 * member that forgot to close an idea does not leave it stuck, and freeze the
 * claims of members that ended abnormally. Returns the released idea ids.
 */
async function reconcileRun(run: HordeRun): Promise<number[]> {
  const abnormalOwners = run.members
    .filter((m) => m.endCause && m.endCause !== "completed")
    .map((m) => ({ name: m.name, cause: m.endCause ?? "unknown" }));
  const owners = Array.from(
    new Set([
      ...run.members.map((member) => member.name),
      ...run.cleanStopNames,
      ...abnormalOwners.map((owner) => owner.name),
    ]),
  );
  let releasedIdeas: number[] = [];
  if (owners.length > 0) {
    try {
      const { closed, released } = await reconcileOwnedIdeas(run.hordeDir, run.id, owners);
      releasedIdeas = released;
      if (closed.length > 0 || released.length > 0) {
        const closedText = closed.map((item) => `#${item.id} (F${item.findingId})`).join(", ");
        const releasedText = released.map((id) => `#${id}`).join(", ");
        await postBoard(
          run.hordeDir,
          "parent",
          `finalize: closed ${closedText || "none"}; released ${releasedText || "none"}`,
        );
      }
    } catch (error) {
      safeNotify(run, `horde ${run.id}: could not reconcile ideas (${errorMessage(error)})`, "error");
    }
  }
  if (abnormalOwners.length > 0) {
    try {
      await markClaimsUnverified(run.hordeDir, abnormalOwners);
    } catch (error) {
      safeNotify(run, `horde ${run.id}: could not freeze claims (${errorMessage(error)})`, "error");
    }
  }
  return releasedIdeas;
}

/** Read the ledgers; a ledger removed mid-run reports as empty. */
function readRunLedgers(run: HordeRun): RunLedgers {
  const ledgers: RunLedgers = {
    ideaCounts: { open: 0, inProgress: 0, done: 0 },
    ideas: [],
    findings: [],
    claims: [],
    facts: [],
    resources: [],
  };
  try {
    const doc = parseIdeas(readHordeFile(run.hordeDir, "ideas"));
    ledgers.ideaCounts = countIdeas(doc);
    ledgers.ideas = [...doc.ideas.values()].map((entry) => entry.idea).sort((a, b) => a.id - b.id);
  } catch {
    // IDEAS.md was removed mid-run; report the run without its counters.
  }
  try {
    ledgers.findings = listFindingsForRun(run.hordeDir, run.id);
    ledgers.claims = listClaims(run.hordeDir);
    ledgers.facts = listFacts(run.hordeDir);
    const touched = new Set(readRunResources(run.runDir));
    const resources = listResources(run.hordeDir).filter((resource) => touched.has(resource.id));
    const citing = resourceCitingMembers(resources, ledgers.findings, collaborationState(run.hordeDir, run.id));
    ledgers.resources = resources.map((resource) => ({ ...resource, citedBy: citing.get(resource.id) ?? [] }));
  } catch {
    // FINDINGS/CLAIMS/FACTS.md was removed mid-run.
  }
  return ledgers;
}

/** Stderr signatures a container/process tool prints when its target is already gone. */
const CLEANUP_ABSENT =
  /no such (?:container|process|object|network|volume|image)|not found|no matching processes|is not running/i;

/**
 * Classify a teardown outcome. A teardown is idempotent: removing the target and
 * finding it already absent both leave the resource gone, so only a real error or
 * a timeout is a failure. `pkill`/`pgrep` exit 1 (no match) and the container
 * tools' "no such ..." are the benign absent cases.
 */
export function classifyCleanup(
  command: string,
  result: { code: number | null; timedOut: boolean; stderr: string },
): CleanupStatus {
  if (result.code === 0 && !result.timedOut) return "ok";
  if (result.timedOut) return "failed";
  const isProcessKill = /^\s*p(?:kill|grep)\b/.test(command);
  if (isProcessKill && result.code === 1 && result.stderr.trim() === "") return "noop";
  if (CLEANUP_ABSENT.test(result.stderr)) return "noop";
  return "failed";
}

async function runCleanup(run: HordeRun, item: PendingCleanup): Promise<CleanupResult> {
  if (item.blockedReason) {
    return { name: item.name, command: item.command, status: "failed", detail: `blocked: ${item.blockedReason}` };
  }
  const result = await execPi(
    { command: "bash", args: ["-lc", item.command] },
    { cwd: run.cwd, env: childEnv(), timeoutMs: 60_000, signal: run.controller.signal },
  );
  const status = classifyCleanup(item.command, result);
  const detail =
    status === "ok"
      ? "ok"
      : status === "noop"
        ? "nothing to remove"
        : result.timedOut
          ? "timed out"
          : result.stderr.trim() || `exit ${result.code ?? "signal"}`;
  return { name: item.name, command: item.command, status, detail: oneLine(detail, 160) };
}

/**
 * Tear down the labs this run registered before writing the report, so the
 * report states whether cleanup succeeded and no containers outlive the run.
 */
async function runCleanups(state: HordeState, run: HordeRun): Promise<CleanupResult[]> {
  const pending =
    process.env.PI_HORDE_CLEANUP === "off" ? [] : pendingCleanups(run.hordeDir, run.id);
  if (pending.length === 0) return [];
  run.finalizing = ["cleanup"];
  state.finalizing = run;
  refreshRun(run);
  const cleanups: CleanupResult[] = [];
  for (const item of pending) cleanups.push(await runCleanup(run, item));
  const failed = cleanups.filter((item) => item.status === "failed");
  safeNotify(
    run,
    failed.length > 0
      ? `horde ${run.id}: ${failed.length} cleanup command(s) failed`
      : `horde ${run.id}: cleaned up ${cleanups.length} resource(s)`,
    failed.length > 0 ? "warning" : "info",
  );
  return cleanups;
}

function runOutcome(run: HordeRun): string {
  if (run.canary === "failed" && run.userStop !== true) return "canary-failed";
  if (run.solvedContested) return "solved-contested";
  if (run.acceptance === "incomplete" && !run.stopped) return "completed-incomplete";
  if (run.solved && run.solvedValidatedBy && run.acceptance !== "incomplete") return "solved";
  if (run.solved) return run.acceptance === "incomplete" ? "solved-incomplete" : "solved-unvalidated";
  if (run.solvedContested) return "solved-contested";
  if (run.cleanStopNames.length > 0) return "stopped-clean";
  if (run.stopped) return "stopped-hard";
  return "completed";
}

/** Write SUMMARY.md and REPORT.md; returns the report input for the synthesis rewrite. */
function writeRunReports(
  run: HordeRun,
  ledgers: RunLedgers,
  releasedIdeas: number[],
  cleanups: CleanupResult[],
  now: number,
): RunReport {
  const { findings, claims, facts, resources } = ledgers;
  const clusters = clusterFindings(findings);
  // Results that only reached the board during wrap-up would otherwise be
  // invisible to REPORT.md; surface them in the diagnosis.
  const latePosts = lateBoardPosts(run.hordeDir, run.id, findings);
  const consistencyWarnings = reportConsistencyWarnings(run, findings, clusters, resources);
  const reviewState = collaborationState(run.hordeDir, run.id);
  run.diagnosis = buildDiagnosis(run, {
    findings,
    scopedReviews: reviewState.reviews,
    reviewMessages: reviewState.messages,
    distinctFindings: clusters.length,
    claims,
    released: releasedIdeas,
    latePosts,
  });
  const memberPosts = lastBoardPostsByMember(run.hordeDir, run.id);
  writeRunFile(
    run,
    "SUMMARY.md",
    summaryMarkdown({ ...run, findings, ideas: ledgers.ideas, memberPosts, scopedReviews: reviewState.reviews, reviewMessages: reviewState.messages }, now),
  );
  const reportInput: RunReport = {
    ...run,
    outcome: runOutcome(run),
    scopedReviews: reviewState.reviews,
    reviewMessages: reviewState.messages,
    canary: run.canary,
    canaryError: run.canaryError,
    findings,
    ideas: ledgers.ideas,
    releasedIdeas,
    clusters,
    claims,
    facts: facts.filter((fact) => fact.id > run.startFactId),
    priorFacts: facts.filter((fact) => fact.id <= run.startFactId),
    resources,
    cleanups,
    solvedValidatedBy: run.solvedValidatedBy,
    solvedContested: run.solvedContested,
    lateBoardPosts: latePosts,
    consistencyWarnings,
  };
  writeRunFile(run, "REPORT.md", runReportMarkdown(reportInput, now));
  return reportInput;
}

/** Generate DELIVERABLE.md and append a capped block of its verification warnings. */
async function produceDeliverable(
  state: HordeState,
  run: HordeRun,
  ledgers: RunLedgers,
  consistencyWarnings: string[],
): Promise<void> {
  run.deliverable = await runDeliverable(state, run);
  if (!run.deliverable) return;
  const warnings = generatedArtifactWarnings(
    run,
    "DELIVERABLE.md",
    run.deliverable,
    ledgers.resources,
    ledgers.findings,
  );
  if (warnings.length > 0) {
    consistencyWarnings.push(...warnings);
    // A wall of low-confidence warnings makes the artifact less trustworthy.
    const inline = warnings.slice(0, INLINE_WARNING_CAP);
    run.deliverable +=
      `\n\n## Verification warnings\n\n` +
      inline.map((warning) => `- ${warning}`).join("\n") +
      (warnings.length > inline.length
        ? `\n- ...and ${warnings.length - inline.length} more (see REPORT.md)`
        : "");
  }
  const acceptanceFile = path.join(run.runDir, "ACCEPTANCE.json");
  const issues: string[] = fs.existsSync(acceptanceFile) ? JSON.parse(fs.readFileSync(acceptanceFile, "utf8")).issues ?? [] : [];
  run.deliverable += `\n\n## Acceptance record\n\nSnapshot: ${run.snapshotHash ?? "unavailable"}. Status: ${run.acceptance ?? "unknown"}. See ACCEPTANCE.md and COLLABORATION.md. Protocol status below is authoritative; prose descriptions do not close requests or accept artifacts.\n${issues.map((issue) => `- ${issue}`).join("\n")}\n`;
  writeRunFile(run, "DELIVERABLE.md", run.deliverable);
}

/**
 * Generate the post-mortem and cross-check the reviewer's cited ids against the
 * ledger. Path existence is not checked: a post-mortem legitimately names absent files.
 */
async function producePostmortem(state: HordeState, run: HordeRun, facts: FactEntry[]): Promise<void> {
  run.postmortem = await runPostmortem(state, run);
  if (!run.postmortem) return;
  let findingIds = new Set<number>();
  try {
    findingIds = new Set(
      parseFindings(readHordeFile(run.hordeDir, "findings")).map((finding) => finding.id),
    );
  } catch {
    // FINDINGS.md was removed mid-run; skip the finding cross-check.
  }
  const factIds = new Set(facts.map((fact) => fact.id));
  const knownResources = new Set(listResources(run.hordeDir).map((resource) => resource.id));
  const notes = ledgerCitationWarnings("post-mortem", run.postmortem, findingIds, factIds);
  for (const id of resourceCitations(run.postmortem)) {
    if (!knownResources.has(id)) notes.push(`post-mortem cites unknown resource R${id}`);
  }
  const unique = [...new Set(notes)];
  if (unique.length > 0) {
    run.postmortem +=
      `\n\n## Consistency notes (automated)\n\n` + unique.map((note) => `- ${note}`).join("\n");
  }
}

/**
 * Run the deliverable and post-mortem helpers, then rewrite REPORT.md with them.
 * The deliverable goes first so the post-mortem reviews the artifact the
 * operator actually reads, not a REPORT.md that predates it.
 */
async function synthesize(
  state: HordeState,
  run: HordeRun,
  ledgers: RunLedgers,
  reportInput: RunReport,
  now: number,
): Promise<void> {
  // A solved run is an early success, not an abort, so it still gets the
  // automatic post-mortem; only a genuine user stop suppresses it.
  const autoPostmortem =
    process.env.PI_HORDE_POSTMORTEM !== "off" &&
    (run.userStop !== true || run.solved !== undefined);
  const wantPostmortem = run.postmortemFlag === true || autoPostmortem;
  const hardStop = run.cleanStopNames.length === 0 && run.userStop === true;
  const wantDeliverable = process.env.PI_HORDE_DELIVERABLE !== "off" && !hardStop;
  const steps: string[] = [];
  if (wantDeliverable) steps.push("deliverable");
  if (wantPostmortem) steps.push("post-mortem");
  if (steps.length > 0) {
    run.finalizing = steps;
    state.finalizing = run;
    refreshRun(run);
  }
  run.deliverable = undefined;
  if (wantDeliverable) {
    await recordPhase(run, "deliverable", "start");
    await produceDeliverable(state, run, ledgers, reportInput.consistencyWarnings);
    await recordPhase(run, "deliverable", "end", { written: Boolean(run.deliverable) });
  }
  if (wantPostmortem) {
    run.finalizing = ["post-mortem"];
    refreshRun(run);
  }
  run.postmortem = undefined;
  if (wantPostmortem) {
    await recordPhase(run, "post-mortem", "start");
    await producePostmortem(state, run, ledgers.facts);
    await recordPhase(run, "post-mortem", "end", { written: Boolean(run.postmortem) });
  }
  if (!run.postmortem && !run.deliverable) return;
  try {
    if (run.postmortem) {
      fs.writeFileSync(path.join(run.runDir, "POSTMORTEM.md"), run.postmortem, "utf-8");
    }
    fs.writeFileSync(
      path.join(run.runDir, "REPORT.md"),
      runReportMarkdown(
        { ...reportInput, postmortem: run.postmortem, deliverable: run.deliverable },
        now,
      ),
      "utf-8",
    );
  } catch (error) {
    safeNotify(
      run,
      `horde ${run.id}: could not write synthesis files (${errorMessage(error)})`,
      "error",
    );
  }
}

function sendReport(state: HordeState, run: HordeRun, ledgers: RunLedgers, now: number): void {
  const sections = [reportText(run, ledgers.ideaCounts, ledgers.findings.length, now)];
  if (run.deliverable) sections.push("## Deliverable", "", run.deliverable);
  if (run.postmortem) sections.push("## Post-mortem", "", run.postmortem);
  state.pi.sendMessage(
    {
      customType: REPORT_TYPE,
      content: sections.join("\n\n"),
      display: true,
      details: reportDetails(run, now),
    },
    // A clean stop has wind-down summaries worth synthesizing; a hard stop
    // and a normal finish keep the parent idle unless it is not stopped.
    { deliverAs: "followUp", triggerTurn: run.cleanStopNames.length > 0 || !run.stopped },
  );
  safeNotify(run, `horde ${run.id} ${run.stopped ? "stopped" : "finished"}`, "info");
}

/** GRAPH.md: the run's Mermaid graph, linked to the dashboard when one was started. */
export function writeRunGraph(run: HordeRun): void {
  try {
    const graph = buildRunGraph({
      runId: run.id,
      events: readEvents(run.hordeDir, run.id),
      members: run.members.map((member) => ({ name: member.name, status: member.status })),
      startedAt: run.startedAt,
    });
    writeRunFile(run, "GRAPH.md", runGraphMarkdown(graph, run.dashboardUrl ?? ""));
  } catch (error) {
    safeNotify(run, `horde ${run.id}: could not build GRAPH.md (${errorMessage(error)})`, "error");
  }
}

/** Wind a run down once every member has exited: reconcile, report, synthesize, notify. */
export async function finalizeRun(state: HordeState, run: HordeRun): Promise<void> {
  const now = Date.now();
  try {
    if (state.disposed) return;
    stopRunTimers(run);
    const answer = settleSolved(run);
    const releasedIdeas = await reconcileRun(run);
    const ledgers = readRunLedgers(run);
    const acceptance = freezeAcceptance(run.hordeDir, run.id, run.startIdeaId);
    run.acceptance = acceptance.status;
    run.snapshotHash = acceptance.hash;
    await recordLifecycle(run, "acceptance", { status: acceptance.status, hash: acceptance.hash, issues: acceptance.issues.length });
    const annotate = answer !== undefined && acceptance.issues.length > 0;
    if (annotate) annotateAnswer(run, answer, acceptance);
    // Workers and bounded repairs have exited; only now may their labs be torn down.
    const cleanups = await runCleanups(state, run);
    const reportInput = writeRunReports(run, ledgers, releasedIdeas, cleanups, now);
    // Free the slot before the (possibly slow) synthesis so a new run can start.
    if (state.active === run) state.active = undefined;
    await synthesize(state, run, ledgers, reportInput, now);
    if (annotate && run.deliverable) annotateAnswer(run, answer, acceptance);
    sendReport(state, run, ledgers, now);
    await recordLifecycle(run, "run-end", { outcome: runOutcome(run), elapsedMs: Date.now() - run.startedAt, stopLabel: run.stopLabel });
    writeRunGraph(run);
  } catch (error) {
    safeNotify(run, `horde ${run.id} failed to finalize: ${errorMessage(error)}`, "error");
  } finally {
    if (state.active === run) state.active = undefined;
    run.finalizing = undefined;
    if (state.finalizing === run) state.finalizing = undefined;
    unmountWidget(run);
  }
}
