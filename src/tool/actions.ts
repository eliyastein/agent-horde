import { postBoard } from "../ledger/board.js";
import { assertClaim, confirmClaim, contestClaim, listClaims, retractClaim, supersedeClaim } from "../ledger/claims.js";
import type { ClaimEntry } from "../ledger/claims.js";
import { listConcerns } from "../ledger/concerns.js";
import { addFact, factUnsettled, listFacts, unsettledFactCitations } from "../ledger/facts.js";
import type { FactEntry } from "../ledger/facts.js";
import * as path from "node:path";
import { CLUSTER_THRESHOLD } from "../ledger/clusters.js";
import { collaborationState } from "../ledger/collaboration.js";
import { addFinding, amendFinding, answerCitations, findingReviewState, findingRevision, findingSummaries, listFindingsForRun, pendingReviewsForMember, staleAnswerCitations, verifyFinding } from "../ledger/findings.js";
import { textOverlap } from "../ledger/text-match.js";
import { addIdea, claimIdea, dropIdea, finishIdea, listIdeas, ruleOutIdea } from "../ledger/ideas.js";
import type { Idea } from "../ledger/ideas.js";
import { claimResource, listResources } from "../ledger/resources.js";
import { cleanStopRequestedFor, confirmSolved, contestSolved, markSolved, readSolved } from "../ledger/run-signals.js";
import { oneLine } from "../format.js";
import type { SiblingHorde } from "../member.js";
import { validateFindingResourceCitations } from "../citations.js";
import { idleHint } from "./hints.js";
import type { HordeToolParams } from "./params.js";
import { COLLABORATION_ACTIONS, runCollaborationAction } from "./collaboration-actions.js";
import { readEvents, recordEvent } from "../ledger/events.js";
import type { EventContext } from "../ledger/events.js";

const CLEAN_STOP_NOTICE =
  "A clean stop was requested by the user. Stop starting new work. Mark your claimed ideas done " +
  "or drop them, post a one-line status to BOARD.md, then write your final summary and make no " +
  "further tool calls.";

/** Actions that start new work, refused while a clean stop is pending for the member. */
const NEW_WORK_ACTIONS = new Set<HordeToolParams["action"]>(["idea", "claim", "assert", "resource"]);

const WORK_PLAN_POST =
  /^\s*(?:plan\s*:|i (?:will|plan to)\b|i'll\b|starting (?:with|on)\b|focus\s*:)/i;

interface ActionResult {
  text: string;
  id?: number;
  /** True when the call changed nothing, such as a duplicate idea. */
  noop?: boolean;
  /** For confirm-solved: whether this confirmation validated the proposal or joined an earlier one. */
  confirmation?: "credited" | "additional";
  /** For amend: the revisions the edit moved between, and whether the claim line changed; reattest reads them. */
  previousRevision?: string;
  revision?: string;
  titleChanged?: boolean;
}

interface ActionContext {
  hordeDir: string;
  member: string;
  params: HordeToolParams;
  runId: string | undefined;
  /** True when a clean stop is pending for this member. */
  cleanStop: boolean;
  /** The member's role instruction, when one was assigned. */
  role: string | undefined;
  /** Other hordes of the swarm whose ledgers the read actions include, tagged by label. */
  siblings: SiblingHorde[];
}

/**
 * Shared read, local write: the read actions append each sibling horde's entries, tagged `[hN]`,
 * so a fact, a rule-out or a resource another horde recorded is not re-derived here. A sibling
 * whose ledger cannot be read is reported, not fatal.
 */
function siblingSections(siblings: SiblingHorde[], what: string, lines: (hordeDir: string) => string[]): string {
  return siblings
    .map((sibling) => {
      const tag = `[${sibling.label}]`;
      let entries: string[];
      try {
        entries = lines(sibling.hordeDir).map((line) => `${tag} ${line}`);
      } catch (error) {
        entries = [`${tag} unreadable: ${oneLine(error instanceof Error ? error.message : String(error), 120)}`];
      }
      const head = `${tag} ${what} of horde ${sibling.label} (read-only; ${sibling.hordeDir}):`;
      return `\n\n${head}\n${entries.length > 0 ? entries.join("\n") : `${tag} none`}`;
    })
    .join("");
}

export function isVerifierRole(role: string | undefined): boolean {
  return /verifier/i.test(role ?? "");
}

type ActionHandler = (ctx: ActionContext) => ActionResult | Promise<ActionResult>;

function requireId(params: HordeToolParams): number {
  if (typeof params.id !== "number") {
    throw new Error(`horde: id is required for action '${params.action}'`);
  }
  return params.id;
}

/** The result line of a closed idea: `text`, or `note` when a member reached for that field instead. */
function closeNote(params: HordeToolParams): string | undefined {
  return params.text ?? params.note;
}

/** The member whose `idea` write created #id in this run, from the event log; undefined outside a run. */
function ideaAuthor(hordeDir: string, runId: string | undefined, id: number): string | undefined {
  if (!runId) return undefined;
  const created = readEvents(hordeDir, runId).find(
    (event) => event.action === "idea" && event.outcome === "applied" && (event.payload.result as { id?: unknown } | undefined)?.id === id,
  );
  return created?.actor;
}

function requireRun(ctx: ActionContext): string {
  if (!ctx.runId) throw new Error(`horde: ${ctx.params.action} needs an active run`);
  return ctx.runId;
}

function normalizeConcern(value: string | undefined): string {
  const concern = oneLine(value ?? "", 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (concern.length < 3) {
    throw new Error(
      "horde: finding concern is required and must be a short stable slug for the subject or " +
        "issue, such as auth-token-refresh or chapter-3-voice",
    );
  }
  return concern;
}

/** Text for a finished idea, plus the idle nudge unless the member is winding down. */
function closedIdea(ctx: ActionContext, idea: Idea, text: string): ActionResult {
  const hint = ctx.cleanStop ? "" : idleHint(ctx.hordeDir, ctx.member);
  return { text: `${text}${hint}`, id: idea.id };
}

function ideaLine(idea: Idea): string {
  const owner = idea.owner ? ` @${idea.owner}` : "";
  const note = idea.note ? `: ${idea.note}` : "";
  return `#${idea.id} [${idea.mark}]${owner} ${idea.text}${note}`;
}

function listAction({ hordeDir, siblings }: ActionContext): ActionResult {
  const ideas = listIdeas(hordeDir);
  const own = ideas.length === 0 ? "IDEAS.md has no ideas yet" : ideas.map(ideaLine).join("\n");
  // Only closed ideas cross hordes: results prevent re-derivation, open ones would invite claims.
  const shared = siblingSections(siblings, "done and ruled-out ideas", (dir) =>
    listIdeas(dir).filter((idea) => idea.mark === "x" || idea.mark === "!").map(ideaLine));
  return { text: `${own}${shared}` };
}

async function postAction({ hordeDir, member, params }: ActionContext): Promise<ActionResult> {
  const text = params.text ?? "";
  const ownsWork = listIdeas(hordeDir).some((idea) => idea.mark === "~" && idea.owner === member);
  if (!ownsWork && WORK_PLAN_POST.test(text)) {
    return {
      text: "Claim a non-overlapping idea before posting a work plan. Ownership belongs in IDEAS.md.",
    };
  }
  await postBoard(hordeDir, member, text);
  return { text: "Posted to BOARD.md" };
}

/** A finding is filed under a claimed idea, unless it attaches evidence to another finding. */
function checkFindingIdea({ hordeDir, member, params }: ActionContext): void {
  if (params.idea === undefined) {
    throw new Error("horde: finding idea is required; claim the work before reporting it");
  }
  const idea = listIdeas(hordeDir).find((entry) => entry.id === params.idea);
  if (!idea) throw new Error(`horde: idea #${params.idea} does not exist`);
  // Independent evidence (deltaOf) and corrections (supersedes) are filed under
  // the reporter's idea, so the verifier does not need to own it.
  const attaches = params.deltaOf !== undefined || params.supersedes !== undefined;
  if (!attaches && idea.owner !== member) {
    throw new Error(
      `horde: idea #${params.idea} is ${idea.owner ? `owned by ${idea.owner}` : "unclaimed"}; ` +
        "claim it before filing, or use deltaOf/supersedes to attach to another member's " +
        "finding",
    );
  }
  if (!params.support) {
    throw new Error(
      "horde: finding support is required; choose how strongly it is supported (reproduced/" +
        "tested/derived/sourced/speculative)",
    );
  }
}

async function findingAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params, runId } = ctx;
  checkFindingIdea(ctx);
  const text = params.text ?? "";
  validateFindingResourceCitations(hordeDir, runId, text);
  const concern = normalizeConcern(params.concern);
  const { finding, duplicateOf, corroborationFull, concernAdvisory } = await addFinding(
    hordeDir,
    runId ?? "",
    member,
    text,
    {
      ideaId: params.idea,
      importance: params.importance,
      confidence: params.confidence,
      support: params.support,
      concern,
      concernDef: params.concernDef,
      concernNew: params.concernNew,
      deltaOf: params.deltaOf,
      supersedes: params.supersedes,
    },
  );
  if (duplicateOf) {
    return {
      text: corroborationFull
        ? `F${finding.id} already has an independent validator. Pick an open idea unless you have distinct evidence.`
        : `F${finding.id} already records this: "${finding.title}". ` +
          `Add only a delta with distinct evidence; otherwise pick an open idea`,
      id: finding.id,
    };
  }
  const advisory = concernAdvisory ? `\nNote: ${concernAdvisory}` : "";
  return { text: `Recorded finding F${finding.id} [${concern}]: ${finding.title}${advisory}${unregisteredHarness(ctx, text)}`, id: finding.id };
}

const HARNESS_PATH = /\bartifacts\/[\w./-]+\.(?:py|js|mjs|cjs|ts|sh|go|rs|rb|pl)\b/g;

/**
 * A driver or harness every member rewrote because nobody registered it: a runnable under
 * artifacts/ that no resource note and no published artifact names is pointed at `resource`.
 */
function unregisteredHarness(ctx: ActionContext, text: string): string {
  const paths = [...new Set(text.match(HARNESS_PATH) ?? [])];
  if (!paths.length) return "";
  const known = listResources(ctx.hordeDir).map((resource) => `${resource.name} ${resource.note ?? ""}`).join("\n");
  const published = ctx.runId ? collaborationState(ctx.hordeDir, ctx.runId).artifacts.map((artifact) => artifact.path) : [];
  const unregistered = paths.filter((file) => !known.includes(file) && !published.some((artifact) => file.endsWith(artifact)));
  if (!unregistered.length) return "";
  return `\nNote: ${unregistered.join(", ")} looks like a harness no R# covers. Claim it with 'horde resource' (name in text, path in note) so other members reuse it instead of writing their own.`;
}

function concernsAction({ hordeDir }: ActionContext): ActionResult {
  const concerns = listConcerns(hordeDir);
  if (concerns.length === 0) return { text: "CONCERNS.md has no concerns yet" };
  return {
    text: concerns
      .map((entry) => {
        const author = entry.author ? ` @${entry.author}` : "";
        return `${entry.slug}: ${entry.definition}${author}`;
      })
      .join("\n"),
  };
}

async function verifyAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params } = ctx;
  const { finding, alreadyBy } = await verifyFinding(hordeDir, requireRun(ctx), member, {
    id: requireId(params),
    support: params.support,
    text: params.text,
  });
  if (alreadyBy) {
    return { text: `F${finding.id} was already verified by ${alreadyBy}`, id: finding.id };
  }
  return {
    text: `Verified F${finding.id} [${finding.verifiedSupport}] by ${member}: ` + finding.title,
    id: finding.id,
  };
}

async function amendAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params, runId } = ctx;
  validateFindingResourceCitations(hordeDir, runId, params.text ?? "");
  const { finding, previous, titleChanged } = await amendFinding(hordeDir, requireRun(ctx), member, {
    id: requireId(params),
    text: params.text,
    note: params.note,
  });
  return {
    text:
      `Amended F${finding.id}: ${finding.title}. Revision ${previous.slice(0, 12)} is superseded by the new text; ` +
      "reviews stay pinned to the revision they checked. " +
      (titleChanged ? "The claim line changed, so reviewers must review again." : "Ask reviewers to reattest if what they checked is unchanged, or to review again."),
    id: finding.id,
    previousRevision: previous,
    revision: findingRevision(finding),
    titleChanged,
  };
}

async function factAction({ hordeDir, member, params }: ActionContext): Promise<ActionResult> {
  const { fact, duplicateOf, corroborationFull } = await addFact(
    hordeDir,
    member,
    params.text,
    params.deltaOf,
  );
  if (duplicateOf) {
    return {
      text: corroborationFull
        ? `Fact T${fact.id} already has an independent corroborator: ${fact.text}`
        : `Fact T${fact.id} already recorded: ${fact.text}. ` +
          `Add only a delta with 'delta-of: T${fact.id}' if you have a distinct extension.`,
      id: fact.id,
    };
  }
  const provisional = fact.provisionalOn
    ? `\nT${fact.id} is provisional: ${fact.provisionalOn} is still auditing its subject. The answer may not quote it as settled until ${fact.provisionalOn} is closed or resolved; cite that closure with it.`
    : "";
  return { text: `Recorded fact T${fact.id}: ${fact.text}${provisional}`, id: fact.id };
}

function factLines(hordeDir: string): string[] {
  const status = (fact: FactEntry): string => {
    if (!fact.provisionalOn) return "";
    return factUnsettled(hordeDir, fact) ? ` [provisional: ${fact.provisionalOn} open]` : ` [was provisional on ${fact.provisionalOn}, now closed]`;
  };
  return listFacts(hordeDir).map((fact) => `T${fact.id} ${fact.text} @${fact.author}${status(fact)}`);
}

function factsAction({ hordeDir, siblings }: ActionContext): ActionResult {
  const own = factLines(hordeDir);
  const shared = siblingSections(siblings, "facts", factLines);
  return { text: `${own.length === 0 ? "FACTS.md has no facts yet" : own.join("\n")}${shared}` };
}

/** An answer that quotes a provisional fact as settled asserts what an open idea is still auditing. */
function unsettledAnswerFacts(ctx: ActionContext, text: string): string | undefined {
  const unsettled = unsettledFactCitations(ctx.hordeDir, text);
  return unsettled.length ? `quotes provisional ${unsettled.join(", ")}` : undefined;
}

async function assertAction({ hordeDir, member, params }: ActionContext): Promise<ActionResult> {
  const claim = await assertClaim(hordeDir, member, params.text);
  return { text: `Asserted C${claim.id}: ${claim.statement}`, id: claim.id };
}

type ClaimTransition = (
  hordeDir: string,
  member: string,
  id: number,
  note: string | undefined,
) => Promise<ClaimEntry>;

/** Handler for an action that moves claim C#id to a new state. */
function claimStateAction(transition: ClaimTransition, verb: string): ActionHandler {
  return async ({ hordeDir, member, params }) => {
    const claim = await transition(hordeDir, member, requireId(params), params.text);
    return { text: `${verb} C${claim.id} [${claim.state}]`, id: claim.id };
  };
}

function claimsAction({ hordeDir }: ActionContext): ActionResult {
  const claims = listClaims(hordeDir);
  if (claims.length === 0) return { text: "CLAIMS.md has no claims yet" };
  return {
    text: claims
      .map(
        (claim) =>
          `C${claim.id} [${claim.state}]${claim.owner ? ` @${claim.owner}` : ""} ` +
          claim.statement +
          (claim.notes.length > 0 ? ` - ${claim.notes.join(" | ")}` : ""),
      )
      .join("\n"),
  };
}

async function ideaAction({ hordeDir, member, params }: ActionContext): Promise<ActionResult> {
  const { idea, duplicateOf } = await addIdea(hordeDir, member, params.text);
  if (duplicateOf) {
    const note = duplicateOf.note ? `: ${duplicateOf.note}` : "";
    const state =
      duplicateOf.mark === "x"
        ? `already done in #${duplicateOf.id}${note}`
        : duplicateOf.mark === "!"
          ? `already ruled out in #${duplicateOf.id}${note}`
          : `already exists as #${duplicateOf.id}`;
    return {
      text: `Idea ${state}. Build on it instead of adding a duplicate`,
      id: duplicateOf.id,
      noop: true,
    };
  }
  return { text: `Added idea #${idea.id}: ${idea.text}`, id: idea.id };
}

/**
 * The verifier reviews before it investigates: a verifier that claimed ideas and filed the
 * run's main findings left its first session with zero scoped reviews while its summary
 * reported verification complete. Any verdict counts; a finding it cannot reproduce gets a
 * refuting or inconclusive review, not silence.
 */
function checkVerifierClaim(ctx: ActionContext): void {
  if (!ctx.runId || !isVerifierRole(ctx.role)) return;
  const pending = pendingReviewsForMember(ctx.hordeDir, ctx.runId, ctx.member);
  if (!pending.length) return;
  throw new Error(
    `horde: you are the verifier and ${pending.length} finding(s) by other members await your review: ` +
      `${pending.map((f) => `F${f.id}`).join(", ")}. Review each (any verdict, with its unchecked scope) before claiming an idea`,
  );
}

/** Findings of this run that already have an independent corroborator or a full review and overlap the idea. */
function reproducedOverlap(ctx: ActionContext, idea: Idea): string {
  if (!ctx.runId) return "";
  const state = collaborationState(ctx.hordeDir, ctx.runId);
  const settled = listFindingsForRun(ctx.hordeDir, ctx.runId).filter((f) =>
    f.supersededBy === undefined && (f.corroborators.length > 0 || findingReviewState(f, state.reviews, state.messages).status === "full"));
  const match = textOverlap(settled.map((f) => f.title), idea.text);
  if (!match || Math.max(match.jaccard, match.overlap) < CLUSTER_THRESHOLD) return "";
  const finding = settled[match.index];
  if (!finding) return "";
  return `\nNote: F${finding.id} ("${finding.title}") is already independently reproduced; a further reproduction adds nothing. Attach a new vector or distinct evidence with deltaOf: ${finding.id}, or take a different slice.`;
}

async function claimAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params } = ctx;
  checkVerifierClaim(ctx);
  const { idea, overlap } = await claimIdea(hordeDir, member, requireId(params));
  const warning = overlap
    ? `\nWarning: #${overlap.id} held by ${overlap.owner} covers a similar slice ("${overlap.text}"). ` +
      `Coordinate: take a distinct angle, or attach evidence to #${overlap.id} with a finding or contest.`
    : "";
  return { text: `Claimed #${idea.id}: ${idea.text}${warning}${reproducedOverlap(ctx, idea)}`, id: idea.id };
}

async function resourceAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params, runId } = ctx;
  if ((params.text ?? "").trim() === "") throw new Error("horde: resource needs its name in text (note holds the reuse pointer)");
  const { resource, reused, ownedByCaller } = await claimResource(hordeDir, member, {
    name: params.text,
    note: params.note,
    cleanup: params.cleanup,
    runId,
  });
  if (ownedByCaller) {
    return {
      text: `Resource R${resource.id} "${resource.name}" is already yours${resource.note ? ` (${resource.note})` : ""}`,
      id: resource.id,
    };
  }
  if (reused) {
    return {
      text:
        `Resource R${resource.id} "${resource.name}" is already claimed by ${resource.owner}${resource.ownerRunId ? ` in run ${resource.ownerRunId}` : " (legacy ownership)"}` +
        `${resource.note ? `: ${resource.note}` : ""}. Reuse it instead of rebuilding, and cite R${resource.id}.`,
      id: resource.id,
    };
  }
  return {
    text: `Claimed resource R${resource.id} "${resource.name}". Other members will reuse it${params.note ? ` (${params.note})` : ""}`,
    id: resource.id,
  };
}

function resourceLines(hordeDir: string): string[] {
  return listResources(hordeDir).map(
    (resource) =>
      `R${resource.id} ${resource.name} @${resource.owner}` +
      `${resource.note ? `: ${resource.note}` : ""}` +
      `${resource.reusers.length > 0 ? ` reuse=${resource.reusers.join(",")}` : ""}`,
  );
}

function resourcesAction({ hordeDir, siblings }: ActionContext): ActionResult {
  const own = resourceLines(hordeDir);
  const shared = siblingSections(siblings, "resources (reuse by path; cite the path, not the R#)", resourceLines);
  return { text: `${own.length === 0 ? "RESOURCES.md has no resources yet" : own.join("\n")}${shared}` };
}

/**
 * An answer that cites a superseded finding, or one amended since the proposal pinned it, ships a
 * stale reading as the run's result. The proposer cites the current text instead; a validator is
 * refused until the proposer re-proposes.
 */
function staleAnswer(ctx: ActionContext, text: string, cites?: Record<string, string>): string | undefined {
  const runId = requireRun(ctx);
  const stale = staleAnswerCitations(listFindingsForRun(ctx.hordeDir, runId), text, cites);
  if (!stale.length) return undefined;
  return `cites ${stale.join(", ")}`;
}

async function solvedAction(ctx: ActionContext): Promise<ActionResult> {
  const runId = requireRun(ctx);
  const text = ctx.params.text ?? "";
  const stale = staleAnswer(ctx, text);
  if (stale) throw new Error(`horde: the answer ${stale}; cite the current findings and propose again`);
  const unsettled = unsettledAnswerFacts(ctx, text);
  if (unsettled) throw new Error(`horde: the answer ${unsettled}; close the idea or resolve the claim first, or leave the fact out`);
  const { signal, alreadySolved } = await markSolved(
    ctx.hordeDir,
    runId,
    ctx.member,
    ctx.params.text,
    answerCitations(listFindingsForRun(ctx.hordeDir, runId), text),
  );
  return {
    text: alreadySolved
      ? `A SOLVED proposal is already pending from ${signal.member}: ${signal.text}. Continue distinct claimed work while another member validates or contests it.`
      : `Proposed SOLVED: ${signal.text}. Another member must validate with 'horde confirm-solved' or refute it with 'horde contest-solved'. Continue distinct claimed work until the parent confirms coverage.`,
  };
}

async function confirmSolvedAction(ctx: ActionContext): Promise<ActionResult> {
  const runId = requireRun(ctx);
  const proposal = readSolved(path.join(ctx.hordeDir, "runs", runId));
  const stale = proposal ? staleAnswer(ctx, proposal.text, proposal.cites) : undefined;
  if (stale) throw new Error(`horde: the pending answer ${stale}; it cannot be validated until ${proposal?.member} re-proposes against the current findings`);
  const unsettled = proposal ? unsettledAnswerFacts(ctx, proposal.text) : undefined;
  if (unsettled) throw new Error(`horde: the pending answer ${unsettled}; close the idea or resolve the claim before validating it`);
  const answer = await confirmSolved(ctx.hordeDir, runId, ctx.member, ctx.params.text, ctx.params.revision);
  if (!answer.ok) throw new Error(`horde: ${answer.reason}`);
  if (answer.reason !== "validated") {
    return {
      text: `Recorded your confirmation; the proposal was already validated by ${answer.by}. Finish your claimed work.`,
      confirmation: "additional",
    };
  }
  return {
    text: "Validated the SOLVED proposal. Finish your claimed work; the parent will wind down once any coverage requirement is satisfied.",
    confirmation: "credited",
  };
}

async function contestSolvedAction(ctx: ActionContext): Promise<ActionResult> {
  const answer = await contestSolved(ctx.hordeDir, requireRun(ctx), ctx.member, ctx.params.text, ctx.params.revision);
  if (!answer.ok) throw new Error(`horde: ${answer.reason}`);
  return {
    text: `Contested the SOLVED proposal: ${oneLine(ctx.params.text ?? "", 160) || "not yet established"}. Work continues; the parent will clear the pause.`,
  };
}

/** A result line that reports a confirmed negative: the lead is dead, not merely finished. */
const NEGATIVE_RESULT =
  /\b(?:not (?:exploitable|vulnerable|reachable|reproducible|affected)|does not reproduce|could not reproduce|cannot be reproduced|confirmed negative|negative result|dead end|ruled? out|no (?:vulnerability|exploit|issue|bug|weakness) (?:found|present|exists))\b/i;

async function doneAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params } = ctx;
  const note = closeNote(params) ?? "";
  // Four confirmed negatives were recorded only as done notes and prose, so the next run on the
  // same target re-walked them. A negative closes with rule-out, which later runs can read.
  const negative = NEGATIVE_RESULT.exec(note);
  if (negative) {
    throw new Error(
      `horde: "${negative[0]}" reads as a confirmed negative; close #${requireId(params)} with 'horde rule-out' and the same note so later runs do not retry it. ` +
        "Use done only for work that produced a result.",
    );
  }
  const idea = await finishIdea(hordeDir, member, requireId(params), note || undefined);
  return closedIdea(ctx, idea, `Done #${idea.id}: ${idea.text}`);
}

async function dropAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params, runId } = ctx;
  const id = requireId(params);
  const idea = await dropIdea(hordeDir, member, id, closeNote(params), { author: ideaAuthor(hordeDir, runId, id) });
  return closedIdea(ctx, idea, `Dropped #${idea.id}: ${idea.text}`);
}

async function ruleOutAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params } = ctx;
  const idea = await ruleOutIdea(hordeDir, member, requireId(params), closeNote(params));
  return closedIdea(ctx, idea, `Ruled out #${idea.id}: ${idea.note ?? "dead end"}`);
}

const HANDLERS: Partial<Record<HordeToolParams["action"], ActionHandler>> = {
  list: listAction,
  post: postAction,
  idea: ideaAction,
  claim: claimAction,
  done: doneAction,
  drop: dropAction,
  "rule-out": ruleOutAction,
  finding: findingAction,
  findings: ({ hordeDir, runId }) => ({ text: findingSummaries(hordeDir, runId ?? "") }),
  fact: factAction,
  facts: factsAction,
  assert: assertAction,
  confirm: claimStateAction(confirmClaim, "Confirmed"),
  contest: claimStateAction(contestClaim, "Contested"),
  retract: claimStateAction(retractClaim, "Retracted"),
  supersede: claimStateAction(supersedeClaim, "Superseded"),
  claims: claimsAction,
  resource: resourceAction,
  resources: resourcesAction,
  solved: solvedAction,
  "confirm-solved": confirmSolvedAction,
  "contest-solved": contestSolvedAction,
  concerns: concernsAction,
  verify: verifyAction,
  amend: amendAction,
};

export async function runHordeAction(
  hordeDir: string,
  member: string,
  params: HordeToolParams,
  runId: string | undefined = process.env.PI_HORDE_RUN,
  tracking: { attempt?: string; requestId?: string; role?: string | undefined; siblings?: SiblingHorde[] | undefined } = {},
): Promise<ActionResult> {
  const cleanStop = Boolean(runId && cleanStopRequestedFor(hordeDir, runId, member));
  const { role, siblings = [], ...eventTracking } = tracking;
  const ctx: EventContext = { hordeDir, runId: runId ?? "", actor: member, ...eventTracking, requestId: params.requestId ?? tracking.requestId };
  if (COLLABORATION_ACTIONS.has(params.action)) {
    if (!runId) throw new Error("horde: collaboration needs an active run");
    return runCollaborationAction(ctx, params);
  }
  const handler = HANDLERS[params.action];
  if (!handler) throw new Error(`horde: unknown action '${params.action}'`);
  const reads = ["list", "findings", "facts", "claims", "resources", "concerns"];
  const audit = Boolean(runId && !reads.includes(params.action));
  const intent = audit ? await recordEvent({ ...ctx, requestId: ctx.requestId ? `${ctx.requestId}:intent` : undefined }, params.action, { outcome: "intent", payload: { input: params } }) : undefined;
  try {
    const refused = cleanStop && NEW_WORK_ACTIONS.has(params.action);
    const result = refused ? { text: CLEAN_STOP_NOTICE } : await handler({ hordeDir, member, params, runId, cleanStop, role, siblings });
    // A refusal and a no-op both record `noop`; the no-op keeps `result.noop` so the graph and the
    // report can tell an absorbed duplicate from refused work.
    if (audit) await recordEvent(ctx, params.action, { outcome: refused || result.noop ? "noop" : "applied", payload: { input: params, result }, parents: intent ? [intent.eventId] : [] });
    return result;
  } catch (error) {
    if (audit) await recordEvent(ctx, params.action, { outcome: "rejected", payload: { input: params, error: String(error) }, parents: intent ? [intent.eventId] : [] });
    throw error;
  }
}
