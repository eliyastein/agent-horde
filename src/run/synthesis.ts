import * as fs from "node:fs";
import * as path from "node:path";
import { oneLine } from "../format.js";
import { childEnv, execPi, getPiInvocation } from "../member.js";
import type { HordeRun, HordeState } from "./types.js";

/** How long the post-mortem agent may run. */
const POSTMORTEM_TIMEOUT_MS = Number(process.env.PI_HORDE_POSTMORTEM_MS) || 300_000;

const POSTMORTEM_SYSTEM_PROMPT =
  "You are a post-mortem reviewer for a multi-agent horde run. You have read-only tools. " +
  "Critique the run and the orchestrating extension, not just the underlying project. Be " +
  "concrete: name the observed pattern and the change you recommend. Prefer a short, " +
  "high-signal report over a long one.";

const DELIVERABLE_SYSTEM_PROMPT =
  "You are the synthesis member of a horde. You have read-only tools and must produce one " +
  "deliverable that answers the task the horde was given, not a summary of the process.";

type HelperLabel = "post-mortem" | "deliverable";

/** Run a one-shot pi helper and return its output, or a one-line failure text. */
async function runHelper(
  label: HelperLabel,
  invocation: { command: string; args: string[] },
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await execPi(invocation, {
    cwd,
    env: childEnv(),
    timeoutMs: POSTMORTEM_TIMEOUT_MS,
    signal,
  });
  const text = result.stdout.trim();
  if (result.timedOut) {
    return `${label} agent failed: timed out after ${Math.round(POSTMORTEM_TIMEOUT_MS / 1000)}s`;
  }
  if (result.code !== 0 || text === "") {
    const detail = oneLine(result.stderr.trim() || "no output", 200);
    return `${label} agent failed (code ${result.code ?? "signal"}): ${detail}`;
  }
  return text;
}

/** Read-only pi invocation for a helper, with its own session directory under the run. */
function helperInvocation(
  run: HordeRun,
  sessionDir: string,
  systemPrompt: string,
  task: string,
): { command: string; args: string[] } {
  const sessions = path.join(run.runDir, sessionDir);
  fs.mkdirSync(sessions, { recursive: true });
  const args = ["-p", "--tools", "read,grep,find,ls", "--session-dir", sessions];
  if (run.model) args.push("--model", run.model);
  for (const name of ["BOARD", "FINDINGS", "IDEAS", "FACTS", "CLAIMS", "RESOURCES", "CONCERNS"]) {
    const frozen = path.join(run.runDir, "snapshot", `${name}.md`);
    if (fs.existsSync(frozen)) task = task.split(path.join(run.hordeDir, `${name}.md`)).join(frozen);
  }
  task += `\nRead ${path.join(run.runDir, "ACCEPTANCE.md")} and ${path.join(run.runDir, "COLLABORATION.md")} when present. ` +
    "Use the frozen acceptance snapshot. Exclude unreviewed, disputed or stale artifacts from recommended runnable outputs. " +
    "acceptedDocuments establishes document-criteria review only; recommend runnable outputs only from acceptedRunnableArtifacts. Preserve recorded peer confirmation even if acceptance remains incomplete. " +
    "Disclose partial checks and unresolved coverage. Legacy verified labels alone do not establish a full reproduction.";
  args.push("--approve", "--append-system-prompt", systemPrompt, "--", task);
  return getPiInvocation(args);
}

function postmortemTask(run: HordeRun): string {
  return [
    `Audit the completed horde run ${run.id} and report defects or improvements in the horde`,
    `logic and its output. The task the horde was given: ${oneLine(run.prompt, 400)}`,
    `Read these files with the read tool:`,
    `- ${path.join(run.runDir, "REPORT.md")}`,
    `- ${path.join(run.runDir, "SYSTEM.md")}`,
    `- ${path.join(run.runDir, "SUMMARY.md")}`,
    `- ${path.join(run.runDir, "DELIVERABLE.md")} (already written; review the artifact the operator reads)`,
    `- ${path.join(run.hordeDir, "FINDINGS.md")}`,
    `- ${path.join(run.hordeDir, "IDEAS.md")}`,
    `- ${path.join(run.hordeDir, "BOARD.md")}`,
    `- ${path.join(run.hordeDir, "CLAIMS.md")}`,
    `- ${path.join(run.hordeDir, "FACTS.md")}`,
    `- ${path.join(run.hordeDir, "RESOURCES.md")}`,
    `- ${path.join(run.hordeDir, "CONCERNS.md")}`,
    `- ${run.runDir}/member-*.log`,
    `- ${run.runDir}/ANSWER.md (when a solve was proposed)`,
    `- ${run.runDir}/TASK.md`,
    ``,
    ...(run.verifier
      ? [
          `${run.verifier} held the verifier role: it was told to reproduce other members'`,
          `findings using revision-scoped 'horde review'. Count its current-revision V# records`,
          `in COLLABORATION.md and ACCEPTANCE.json, separating full-scope support, limitations,`,
          `and disputes. Legacy verified= headings are historical metadata, not the review count.`,
          `Acceptance already consumes scoped reviews: unchecked assertions can correctly leave`,
          `a reviewed finding incomplete. Do not diagnose missing verification solely from an absent`,
          `legacy label. Check whether prose overstates the checked scope and whether its coverage`,
          `claim matches the finding-id high-water mark in`,
          `FINDINGS.md at the time it was posted.`,
          ``,
        ]
      : []),
    `Produce a concise markdown post-mortem with these sections:`,
    `## Verdict`,
    `## What worked`,
    `## Defects in the horde logic`,
    `## Improvements`,
    `## Run metrics`,
    ``,
    `Look for duplication, overlapping work, dead or unclaimed items, stop behavior, unused`,
    `features, unverified findings presented as settled, and anything that made the output worse.`,
    `Judge the deliverable against the task above, not against a fixed report format. CLAIMS.md`,
    `is for disputed hypotheses, while ownership is recorded in IDEAS.md; an empty claims ledger`,
    `is not itself a defect. Concern slugs in CONCERNS.md that name the same subject are a`,
    `coordination defect. Base every claim on the files. Do not modify any file. Output only`,
    `the markdown post-mortem.`,
  ].join("\n");
}

function deliverableTask(run: HordeRun): string {
  return [
    `Produce the single deliverable for horde run ${run.id}.`,
    ``,
    `The task the horde was given:`,
    ``,
    run.prompt,
    ``,
    `Read these with the read tool:`,
    `- ${path.join(run.runDir, "REPORT.md")}`,
    `- ${path.join(run.runDir, "SUMMARY.md")}`,
    `- ${path.join(run.hordeDir, "FINDINGS.md")}`,
    `- ${path.join(run.hordeDir, "IDEAS.md")}`,
    `- ${path.join(run.hordeDir, "BOARD.md")}`,
    `- ${path.join(run.hordeDir, "FACTS.md")}`,
    `- ${path.join(run.hordeDir, "CLAIMS.md")}`,
    `- ${path.join(run.hordeDir, "RESOURCES.md")}`,
    `- ${path.join(run.hordeDir, "CONCERNS.md")}`,
    ...(run.plan ? [`- ${path.join(run.runDir, "PLAN.md")}`] : []),
    ``,
    `Produce the artifact the task actually asks for, in the form that task implies. A research`,
    `question wants an analysis or an answer; a creative brief wants the work itself; an`,
    `engineering task wants the spec, patch, or design; an R&D question wants the findings and`,
    `their uncertainty. Do not impose a fixed report skeleton, and drop any metadata that does`,
    `not fit this task.`,
    ``,
    `Ground the deliverable in current-revision reviews and evidence in COLLABORATION.md and`,
    `ACCEPTANCE.json. Separate full-scope support, limited/inconclusive checks, disputes, and`,
    `unreviewed claims. A tested mechanism does not establish unchecked reachability or impact.`,
    `Legacy verified= headings are historical metadata, not the authoritative review count.`,
    `Preserve the reporter's support label and attribute stronger checks to their V# review scope. Fold`,
    `every delta finding (tagged delta=#F) into the parent concern it extends, and for each`,
    `concern with a definition in CONCERNS.md, state it once rather than repeating the same`,
    `conclusion across sections. Use the importance and support labels when they help a reader`,
    `weigh a claim, and omit them when they add nothing. Preserve the distinction between`,
    `reproduction and reasoning: do not present a design, model, or source reading as a`,
    `measurement. Verify that every cited R# and run-artifact path exists. Do not restate`,
    `per-member work or describe the horde process. Output only markdown.`,
  ].join("\n");
}

/** Spawn the read-only reviewer that audits the finished run. */
export async function runPostmortem(state: HordeState, run: HordeRun): Promise<string | undefined> {
  if (state.disposed) return undefined;
  const invocation = helperInvocation(
    run,
    "postmortem-sessions",
    POSTMORTEM_SYSTEM_PROMPT,
    postmortemTask(run),
  );
  const controller = new AbortController();
  run.postmortemAbort = controller;
  try {
    return await runHelper("post-mortem", invocation, run.cwd, controller.signal);
  } finally {
    run.postmortemAbort = undefined;
  }
}

/** Spawn the synthesis member that writes the single merged deliverable. */
export async function runDeliverable(state: HordeState, run: HordeRun): Promise<string | undefined> {
  if (state.disposed) return undefined;
  const invocation = helperInvocation(
    run,
    "deliverable-sessions",
    DELIVERABLE_SYSTEM_PROMPT,
    deliverableTask(run),
  );
  const controller = new AbortController();
  run.deliverableAbort = controller;
  try {
    return await runHelper("deliverable", invocation, run.cwd, controller.signal);
  } finally {
    run.deliverableAbort = undefined;
  }
}
