import { postBoard } from "../ledger/board.js";
import { assertClaim, confirmClaim, contestClaim, listClaims, retractClaim, supersedeClaim } from "../ledger/claims.js";
import type { ClaimEntry } from "../ledger/claims.js";
import { listConcerns } from "../ledger/concerns.js";
import { addFact, listFacts } from "../ledger/facts.js";
import { addFinding, findingSummaries, verifyFinding } from "../ledger/findings.js";
import { addIdea, claimIdea, dropIdea, finishIdea, listIdeas, ruleOutIdea } from "../ledger/ideas.js";
import type { Idea } from "../ledger/ideas.js";
import { claimResource, listResources } from "../ledger/resources.js";
import { cleanStopRequestedFor, confirmSolved, contestSolved, markSolved } from "../ledger/run-signals.js";
import { oneLine } from "../format.js";
import { validateFindingResourceCitations } from "../citations.js";
import { idleHint } from "./hints.js";
import type { HordeToolParams } from "./params.js";
import { COLLABORATION_ACTIONS, runCollaborationAction } from "./collaboration-actions.js";
import { recordEvent } from "../ledger/events.js";
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
}

interface ActionContext {
  hordeDir: string;
  member: string;
  params: HordeToolParams;
  runId: string | undefined;
  /** True when a clean stop is pending for this member. */
  cleanStop: boolean;
}

type ActionHandler = (ctx: ActionContext) => ActionResult | Promise<ActionResult>;

function requireId(params: HordeToolParams): number {
  if (typeof params.id !== "number") {
    throw new Error(`horde: id is required for action '${params.action}'`);
  }
  return params.id;
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

function listAction({ hordeDir }: ActionContext): ActionResult {
  const ideas = listIdeas(hordeDir);
  if (ideas.length === 0) return { text: "IDEAS.md has no ideas yet" };
  return {
    text: ideas
      .map((idea) => {
        const owner = idea.owner ? ` @${idea.owner}` : "";
        const note = idea.note ? `: ${idea.note}` : "";
        return `#${idea.id} [${idea.mark}]${owner} ${idea.text}${note}`;
      })
      .join("\n"),
  };
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
  return { text: `Recorded finding F${finding.id} [${concern}]: ${finding.title}${advisory}`, id: finding.id };
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
  return { text: `Recorded fact T${fact.id}: ${fact.text}`, id: fact.id };
}

function factsAction({ hordeDir }: ActionContext): ActionResult {
  const facts = listFacts(hordeDir);
  if (facts.length === 0) return { text: "FACTS.md has no facts yet" };
  return { text: facts.map((fact) => `T${fact.id} ${fact.text} @${fact.author}`).join("\n") };
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
    };
  }
  return { text: `Added idea #${idea.id}: ${idea.text}`, id: idea.id };
}

async function claimAction({ hordeDir, member, params }: ActionContext): Promise<ActionResult> {
  const { idea, overlap } = await claimIdea(hordeDir, member, requireId(params));
  const warning = overlap
    ? `\nWarning: #${overlap.id} held by ${overlap.owner} covers a similar slice ("${overlap.text}"). ` +
      `Coordinate: take a distinct angle, or attach evidence to #${overlap.id} with a finding or contest.`
    : "";
  return { text: `Claimed #${idea.id}: ${idea.text}${warning}`, id: idea.id };
}

async function resourceAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params, runId } = ctx;
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

function resourcesAction({ hordeDir }: ActionContext): ActionResult {
  const resources = listResources(hordeDir);
  if (resources.length === 0) return { text: "RESOURCES.md has no resources yet" };
  return {
    text: resources
      .map(
        (resource) =>
          `R${resource.id} ${resource.name} @${resource.owner}` +
          `${resource.note ? `: ${resource.note}` : ""}` +
          `${resource.reusers.length > 0 ? ` reuse=${resource.reusers.join(",")}` : ""}`,
      )
      .join("\n"),
  };
}

async function solvedAction(ctx: ActionContext): Promise<ActionResult> {
  const { signal, alreadySolved } = await markSolved(
    ctx.hordeDir,
    requireRun(ctx),
    ctx.member,
    ctx.params.text,
  );
  return {
    text: alreadySolved
      ? `A SOLVED proposal is already pending from ${signal.member}: ${signal.text}. Continue distinct claimed work while another member validates or contests it.`
      : `Proposed SOLVED: ${signal.text}. Another member must validate with 'horde confirm-solved' or refute it with 'horde contest-solved'. Continue distinct claimed work until the parent confirms coverage.`,
  };
}

async function confirmSolvedAction(ctx: ActionContext): Promise<ActionResult> {
  const answer = await confirmSolved(ctx.hordeDir, requireRun(ctx), ctx.member, ctx.params.text, ctx.params.revision);
  if (!answer.ok) throw new Error(`horde: ${answer.reason}`);
  return {
    text:
      answer.reason === "validated"
        ? "Validated the SOLVED proposal. Finish your claimed work; the parent will wind down once any coverage requirement is satisfied."
        : `The SOLVED proposal was already validated by ${answer.by}.`,
  };
}

async function contestSolvedAction(ctx: ActionContext): Promise<ActionResult> {
  const answer = await contestSolved(ctx.hordeDir, requireRun(ctx), ctx.member, ctx.params.text, ctx.params.revision);
  if (!answer.ok) throw new Error(`horde: ${answer.reason}`);
  return {
    text: `Contested the SOLVED proposal: ${oneLine(ctx.params.text ?? "", 160) || "not yet established"}. Work continues; the parent will clear the pause.`,
  };
}

async function doneAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params } = ctx;
  const idea = await finishIdea(hordeDir, member, requireId(params), params.text);
  return closedIdea(ctx, idea, `Done #${idea.id}: ${idea.text}`);
}

async function dropAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params } = ctx;
  const idea = await dropIdea(hordeDir, member, requireId(params), params.text);
  return closedIdea(ctx, idea, `Dropped #${idea.id}: ${idea.text}`);
}

async function ruleOutAction(ctx: ActionContext): Promise<ActionResult> {
  const { hordeDir, member, params } = ctx;
  const idea = await ruleOutIdea(hordeDir, member, requireId(params), params.text);
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
};

export async function runHordeAction(
  hordeDir: string,
  member: string,
  params: HordeToolParams,
  runId: string | undefined = process.env.PI_HORDE_RUN,
  tracking: { attempt?: string; requestId?: string } = {},
): Promise<ActionResult> {
  const cleanStop = Boolean(runId && cleanStopRequestedFor(hordeDir, runId, member));
  const ctx: EventContext = { hordeDir, runId: runId ?? "", actor: member, ...tracking, requestId: params.requestId ?? tracking.requestId };
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
    const result = cleanStop && NEW_WORK_ACTIONS.has(params.action)
      ? { text: CLEAN_STOP_NOTICE }
      : await handler({ hordeDir, member, params, runId, cleanStop });
    if (audit) await recordEvent(ctx, params.action, { outcome: cleanStop && NEW_WORK_ACTIONS.has(params.action) ? "noop" : "applied", payload: { input: params, result }, parents: intent ? [intent.eventId] : [] });
    return result;
  } catch (error) {
    if (audit) await recordEvent(ctx, params.action, { outcome: "rejected", payload: { input: params, error: String(error) }, parents: intent ? [intent.eventId] : [] });
    throw error;
  }
}
