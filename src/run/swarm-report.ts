import * as path from "node:path";
import { formatDateTime, formatElapsed, formatTokens, oneLine } from "../format.js";
import { listFindingsForRun } from "../ledger/findings.js";
import { statusCounts, totalUsage } from "../prompt.js";
import { hordeLabel } from "./types.js";
import type { HordeRun, Swarm } from "./types.js";

/** One horde's totals for the swarm report and the injected message. */
export interface SwarmHordeRow {
  label: string;
  runId: string;
  runDir: string;
  outcome: string;
  members: number;
  done: number;
  failed: number;
  stopped: number;
  turns: number;
  tokens: number;
  cost: number;
  findings: number;
  elapsedMs: number;
  deliverable: boolean;
  postmortem: boolean;
}

/** What the swarm report message carries for its renderer. */
export interface SwarmReportDetails {
  swarmId: string;
  elapsedMs: number;
  hordes: SwarmHordeRow[];
  deliverable?: string | undefined;
}

export const SWARM_REPORT_TYPE = "agent-horde-swarm-report";

function findingCount(run: HordeRun): number {
  try {
    return listFindingsForRun(run.hordeDir, run.id).length;
  } catch {
    return 0;
  }
}

function hordeRow(run: HordeRun, now: number): SwarmHordeRow {
  const counts = statusCounts(run.members);
  const usage = totalUsage(run.members);
  const ended = Math.max(...run.members.map((member) => member.endedAt ?? now), run.startedAt);
  return {
    label: hordeLabel(run.horde),
    runId: run.id,
    runDir: run.runDir,
    outcome: run.outcome ?? (run.finalized ? "finished" : "running"),
    members: run.members.length,
    done: counts.done,
    failed: counts.failed,
    stopped: counts.stopped,
    turns: usage.turns,
    tokens: usage.input + usage.output,
    cost: usage.cost,
    findings: findingCount(run),
    elapsedMs: ended - run.startedAt,
    deliverable: Boolean(run.deliverable),
    postmortem: Boolean(run.postmortem),
  };
}

export function swarmHordeRows(swarm: Swarm, now: number = Date.now()): SwarmHordeRow[] {
  return swarm.runs.map((run) => hordeRow(run, now));
}

function sum(rows: SwarmHordeRow[], pick: (row: SwarmHordeRow) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

function hordeTable(rows: SwarmHordeRow[]): string[] {
  return [
    "| horde | run | outcome | members | done | failed | stopped | turns | tokens | cost | findings | elapsed |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) =>
      `| ${row.label} | ${row.runId} | ${row.outcome} | ${row.members} | ${row.done} | ${row.failed} | ` +
      `${row.stopped} | ${row.turns} | ${formatTokens(row.tokens)} | $${row.cost.toFixed(4)} | ${row.findings} | ${formatElapsed(row.elapsedMs)} |`),
    `| total | | | ${sum(rows, (r) => r.members)} | ${sum(rows, (r) => r.done)} | ${sum(rows, (r) => r.failed)} | ` +
    `${sum(rows, (r) => r.stopped)} | ${sum(rows, (r) => r.turns)} | ${formatTokens(sum(rows, (r) => r.tokens))} | ` +
    `$${sum(rows, (r) => r.cost).toFixed(4)} | ${sum(rows, (r) => r.findings)} | |`,
  ];
}

/** REPORT.md of a swarm: the partition, per-horde totals, where each horde's files are, the merged deliverable. */
export function swarmReportMarkdown(swarm: Swarm, now: number = Date.now()): string {
  const rows = swarmHordeRows(swarm, now);
  return [
    `# Swarm ${swarm.id}`,
    "",
    `- started: ${formatDateTime(new Date(swarm.startedAt))}`,
    `- elapsed: ${formatElapsed(now - swarm.startedAt)}`,
    `- hordes: ${swarm.hordes} x ${swarm.count} members`,
    `- until stop: ${swarm.untilStop ? "yes" : "no"}`,
    `- outcomes: ${rows.map((row) => `${row.label} ${row.outcome}`).join(", ")}`,
    `- merged deliverable: ${swarm.deliverable ? "DELIVERABLE.md" : "not written"}`,
    "",
    "## Prompt",
    "",
    swarm.prompt,
    "",
    "## Partition",
    "",
    ...(swarm.partition ?? []).map((slice, index) => `- ${hordeLabel(index + 1)}: ${slice}`),
    "",
    "## Hordes",
    "",
    ...hordeTable(rows),
    "",
    ...rows.flatMap((row) => [
      `### ${row.label}: ${row.runId}`,
      "",
      `- ${path.join(row.runDir, "REPORT.md")}`,
      ...(row.deliverable ? [`- ${path.join(row.runDir, "DELIVERABLE.md")}`] : []),
      ...(row.postmortem ? [`- ${path.join(row.runDir, "POSTMORTEM.md")}`] : []),
      "",
    ]),
    ...(swarm.deliverable ? ["## Deliverable", "", swarm.deliverable, ""] : []),
  ].join("\n");
}

/** The message injected into the parent conversation when a swarm finishes. */
export function swarmReportText(swarm: Swarm, now: number = Date.now()): string {
  const rows = swarmHordeRows(swarm, now);
  const dir = swarm.dir ?? "";
  return [
    `Swarm ${swarm.id} finished after ${formatElapsed(now - swarm.startedAt)}: ${swarm.hordes} hordes of ` +
      `${swarm.count} members on one task, partitioned as ${rows.map((row) => `${row.label} (${row.outcome})`).join(", ")}.`,
    `${sum(rows, (r) => r.turns)} turns, ${formatTokens(sum(rows, (r) => r.tokens))} tokens, ` +
      `$${sum(rows, (r) => r.cost).toFixed(2)}, ${sum(rows, (r) => r.findings)} findings across the hordes.`,
    "",
    "Partition:",
    ...(swarm.partition ?? []).map((slice, index) => `- ${hordeLabel(index + 1)}: ${oneLine(slice, 200)}`),
    "",
    "Files:",
    `- ${path.join(dir, "REPORT.md")}        per-horde totals and where each horde's files are`,
    ...(swarm.deliverable ? [`- ${path.join(dir, "DELIVERABLE.md")}   merged deliverable, each claim attributed to its horde`] : []),
    `- ${path.join(dir, "SWARM.md")}         the prompt and the partition`,
    ...rows.map((row) => `- ${row.runDir}/   ${row.label}: REPORT.md, DELIVERABLE.md, POSTMORTEM.md, SUMMARY.md`),
    "",
    ...(swarm.deliverable
      ? [
          "The merged deliverable is included below. No horde reviewed another's work, so verify claims",
          "against the owning horde's FINDINGS.md and ACCEPTANCE.md before presenting them to the user.",
        ]
      : ["No merged deliverable was written; read each horde's REPORT.md and DELIVERABLE.md."]),
  ].join("\n");
}
