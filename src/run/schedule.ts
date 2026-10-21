import { collaborationState, openMessages } from "../ledger/collaboration.js";
import type { ArtifactRecord, CollaborationState } from "../ledger/collaboration.js";
import { runCollaborationAction } from "../tool/collaboration-actions.js";
import { currentTarget, targetInfo } from "../tool/collaboration-target.js";
import type { MemberState } from "../member.js";
import type { RunLaunch } from "./supervise.js";
import { safeNotify } from "./ui.js";

const SCHEDULE_INTERVAL_MS = 30_000;
/** A revision younger than this may still be under active repair; reviewing it now goes stale. */
const REVIEW_SETTLE_MS = 60_000;

export function stopReason({ run, state }: RunLaunch): MemberState["repairStopReason"] {
  if (run.stopped || run.userStop) return "user-stop";
  if (state.disposed) return "disposed";
  if (run.controller.signal.aborted) return "master-abort";
  return undefined;
}

interface ScheduleOptions {
  /** Only assign artifacts published at least this long ago. */
  settleMs: number;
  /** During discovery only running members can see a new inbox item. */
  liveOnly: boolean;
}

/**
 * A member that reviewed an earlier revision can reattest a behaviour-neutral change cheaply, so
 * it goes first; otherwise the non-owner with the fewest open review requests, ties to the
 * verifier, then roster order.
 */
function pickReviewer(launch: RunLaunch, load: Map<string, number>, owner: string, liveOnly: boolean, prior: Set<string>): MemberState | undefined {
  const { run } = launch;
  const count = (member: MemberState) => load.get(member.name) ?? 0;
  const candidates = run.members.filter((m) => m.name !== owner && (!liveOnly || m.status === "running"));
  return candidates.sort((a, b) =>
    Number(prior.has(b.name)) - Number(prior.has(a.name)) || count(a) - count(b) || Number(b.name === run.verifier) - Number(a.name === run.verifier))[0];
}

function reviewLoad(state: CollaborationState): Map<string, number> {
  const load = new Map<string, number>();
  for (const m of openMessages(state)) if (m.kind === "review-request") load.set(m.to, (load.get(m.to) ?? 0) + 1);
  return load;
}

function settled(artifact: ArtifactRecord, settleMs: number): boolean {
  if (settleMs <= 0 || !artifact.publishedAt) return true;
  return Date.now() - Date.parse(artifact.publishedAt) >= settleMs;
}

async function assignArtifactReviews(launch: RunLaunch, options: ScheduleOptions): Promise<void> {
  const { run } = launch;
  const ctx = { hordeDir: run.hordeDir, runId: run.id, actor: "parent", attempt: "scheduler" };
  const state = collaborationState(run.hordeDir, run.id);
  const load = reviewLoad(state);
  for (const artifact of state.artifacts) {
    if (stopReason(launch)) return;
    if (!settled(artifact, options.settleMs)) continue;
    if (state.reviews.some((r) => r.target === artifact.id && r.revision === artifact.hash)) continue;
    if (state.messages.some((m) => m.target === artifact.id && m.revision === artifact.hash && m.kind === "review-request")) continue;
    const prior = new Set(state.reviews.filter((r) => r.target === artifact.id && r.actor !== artifact.owner).map((r) => r.actor));
    const reviewer = pickReviewer(launch, load, artifact.owner, options.liveOnly, prior);
    if (!reviewer) continue;
    const carry = prior.has(reviewer.name)
      ? ` You reviewed an earlier revision${artifact.changeNote ? ` (owner's change note: ${artifact.changeNote})` : ""}: if what you checked is unchanged, reattest with evidence instead of repeating the review.`
      : "";
    await runCollaborationAction(ctx, { action: "message", kind: "review-request", target: artifact.id, to: reviewer.name,
      text: `Independently check ${artifact.path}@${artifact.hash} (${artifact.kind ?? "runnable"}) against: ${artifact.criteria}. ` +
        `${artifact.kind === "document" ? "Full-scope sourced/derived review may establish document acceptance; this does not establish runtime reproduction." : "Runnable acceptance requires full independent tested/reproduced support."} ` +
        "Attach evidence and record a revision-scoped review: unchecked names in-criteria gaps, limits names what lies outside the criteria. " +
        `The review closes this parent assignment; a refuting check opens a challenge to the owner.${carry}`,
      requestId: `review:${artifact.id}:${artifact.hash}` });
    load.set(reviewer.name, (load.get(reviewer.name) ?? 0) + 1);
  }
}

/** A cyclic supersession is reported by acceptance; here it must not abort scheduling. */
function successorOf(ctx: { hordeDir: string; runId: string; actor: string }, target: string): string | undefined {
  try {
    const successor = currentTarget(ctx, target);
    return successor === target ? undefined : successor;
  } catch {
    return undefined;
  }
}

/** A pinned dependency whose current revision moved on, with the owner's change note when it is an artifact. */
function revisionDrift(ctx: { hordeDir: string; runId: string; actor: string }, state: CollaborationState, dependency: ArtifactRecord["dependencies"][number]): string | undefined {
  try {
    const current = targetInfo(ctx, state, dependency.target).revision;
    if (current === dependency.revision) return undefined;
    const note = state.artifacts.find((a) => a.id === dependency.target)?.changeNote;
    return `${dependency.target}@${dependency.revision.slice(0, 12)} -> @${current.slice(0, 12)}${note ? ` (${note})` : ""}`;
  } catch {
    return undefined;
  }
}

/**
 * A superseded or re-hashed dependency excludes the artifact from acceptance. Repointing it
 * automatically would carry acceptance to content nobody reviewed against this artifact, so the
 * owner is asked to republish against the successor or the new revision; reviewers of the old
 * revision can then reattest when the change was behaviour-neutral.
 */
async function assignDependencyRepins(launch: RunLaunch): Promise<void> {
  const { run } = launch;
  const ctx = { hordeDir: run.hordeDir, runId: run.id, actor: "parent", attempt: "scheduler" };
  const state = collaborationState(run.hordeDir, run.id);
  for (const artifact of state.artifacts) {
    if (stopReason(launch)) return;
    const moved = artifact.dependencies.flatMap(({ target }) => {
      const successor = successorOf(ctx, target);
      return successor === undefined ? [] : [`${target} -> ${successor}`];
    });
    const drifted = artifact.dependencies.flatMap((dependency) => {
      const drift = successorOf(ctx, dependency.target) === undefined ? revisionDrift(ctx, state, dependency) : undefined;
      return drift === undefined ? [] : [drift];
    });
    if (!moved.length && !drifted.length) continue;
    if (state.messages.some((m) => m.sender === "parent" && m.kind === "handoff" && m.target === artifact.id && m.revision === artifact.hash)) continue;
    const parts = [
      moved.length ? `Dependencies of ${artifact.id} were superseded (${moved.join(", ")}). Check the corrected findings, update ${artifact.path} where the correction changes it, and republish with dependsOn naming the successors.` : "",
      drifted.length ? `Dependencies of ${artifact.id} changed revision (${drifted.join(", ")}). Check whether the change affects ${artifact.path}, then republish with dependsOn pinning the current revisions.` : "",
      "Acceptance needs a review of the new revision; reviewers of the earlier one can reattest when the behaviour they checked is unchanged.",
    ].filter(Boolean);
    await runCollaborationAction(ctx, { action: "message", kind: "handoff", target: artifact.id, to: artifact.owner,
      text: parts.join(" "), requestId: `repin:${artifact.id}:${artifact.hash}` });
  }
}

export async function scheduleCollaboration(launch: RunLaunch, options: ScheduleOptions): Promise<void> {
  await assignDependencyRepins(launch);
  await assignArtifactReviews(launch, options);
}

/** Assign reviews and repins while members are alive, not only after discovery exits. */
export function startCollaborationScheduler(launch: RunLaunch): void {
  const { run } = launch;
  let busy = false;
  let lastError: string | undefined;
  run.scheduleTimer = setInterval(() => {
    if (busy || stopReason(launch) || run.solved) return;
    busy = true;
    scheduleCollaboration(launch, { settleMs: REVIEW_SETTLE_MS, liveOnly: true })
      .then(() => { lastError = undefined; })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastError) safeNotify(run, `horde: review scheduling failed, retrying: ${message}`, "error");
        lastError = message;
      })
      .finally(() => { busy = false; });
  }, SCHEDULE_INTERVAL_MS);
  run.scheduleTimer.unref?.();
}
