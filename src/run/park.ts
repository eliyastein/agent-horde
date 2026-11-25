import * as fs from "node:fs";
import * as path from "node:path";
import { envNumber } from "../format.js";
import { postBoard } from "../ledger/board.js";
import { readEvents } from "../ledger/events.js";
import type { HordeEvent } from "../ledger/events.js";
import { cleanStopRequestedFor } from "../ledger/run-signals.js";
import type { MemberState } from "../member.js";
import { recordLifecycle } from "./lifecycle.js";
import type { HordeRun, HordeState } from "./types.js";
import { refreshRun, safeNotify } from "./ui.js";

/** Consecutive `--until-stop` continuation sessions that add nothing before a member is parked; 0 disables. */
const PARK_AFTER = envNumber("PI_HORDE_PARK_AFTER", 3);

/** How often a parked member checks for new work by others. */
const PARK_POLL_MS = envNumber("PI_HORDE_PARK_POLL_MS", 2_000);

/** Tool actions that add to the run's record. Board posts, ideas and claims do not count. */
const ADDS_WORK = new Set([
  "finding", "fact", "review", "reattest", "artifact", "amend", "attach", "solved", "confirm-solved", "contest-solved",
]);

/** New work by another member that a parked member could review or extend. */
const UNPARKS = new Set(["finding", "artifact", "amend"]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** Whether the call matched an existing finding or fact, so the ledger gained no new record. */
function matchedExistingRecord(event: HordeEvent): boolean {
  const result = event.payload?.result;
  return typeof result === "object" && result !== null && (result as { duplicate?: unknown }).duplicate === true;
}

/** Whether the event is an applied call of one of `actions` that created or changed a record. */
function recordedWork(event: HordeEvent, actions: Set<string>): boolean {
  return event.outcome === "applied" && actions.has(event.action) && !matchedExistingRecord(event);
}

/** Whether the session `attempt` of `member` recorded any work. */
export function sessionAddedWork(events: HordeEvent[], member: string, attempt: string | undefined): boolean {
  return events.some((event) => event.actor === member && event.attempt === attempt && recordedWork(event, ADDS_WORK));
}

/** Whether another member recorded new work after event `since`. */
export function workByOthersSince(events: HordeEvent[], member: string, since: number): boolean {
  return events.some(
    (event) =>
      event.seq > since && event.actor !== member && event.actor.startsWith("member-") && recordedWork(event, UNPARKS),
  );
}

/** Every member is parked or down for good, so nobody is left to produce the work that unparks. */
function everyoneIdle(run: HordeRun): boolean {
  return run.members.every((member) => member.parked === true || run.settled?.has(member.name) === true);
}

/**
 * Called when an `--until-stop` member's session finished and a continuation is due. A member
 * whose last continuation sessions each added nothing is parked here: it gets no fresh session
 * until another member records a finding or an artifact revision. Returns "down" when the member
 * must stay down: the run was stopped, or every member is parked and the run ends as stagnated.
 */
export async function parkIfStagnant(state: HordeState, run: HordeRun, member: MemberState): Promise<"continue" | "down"> {
  if (PARK_AFTER <= 0) return "continue";
  const events = readEvents(run.hordeDir, run.id);
  if ((member.continuations ?? 0) > 0) {
    member.emptyContinuations = sessionAddedWork(events, member.name, member.attempt) ? 0 : (member.emptyContinuations ?? 0) + 1;
  }
  const empty = member.emptyContinuations ?? 0;
  if (empty < PARK_AFTER) return "continue";

  const since = events.at(-1)?.seq ?? 0;
  member.parked = true;
  fs.appendFileSync(path.join(run.runDir, `${member.name}.log`), `[horde] parked: ${empty} continuation session(s) in a row added nothing\n`);
  await recordLifecycle(run, "member-parked", { member: member.name, reason: "stagnated", emptySessions: empty });
  try {
    await postBoard(
      run.hordeDir,
      "parent",
      `${member.name} is parked: its last ${empty} sessions added no finding, fact, review or artifact. ` +
        "It gets a fresh session when another member records a finding or an artifact revision.",
    );
  } catch {
    // The board notice is best effort.
  }
  safeNotify(run, `horde ${run.id}: ${member.name} parked (${empty} sessions added nothing)`, "info");
  refreshRun(run);

  for (;;) {
    if (state.disposed || run.stopped || cleanStopRequestedFor(run.hordeDir, run.id, member.name)) return "down";
    if (run.stagnated || everyoneIdle(run)) {
      run.stagnated = true;
      return "down";
    }
    if (workByOthersSince(readEvents(run.hordeDir, run.id), member.name, since)) {
      member.parked = undefined;
      member.emptyContinuations = 0;
      fs.appendFileSync(path.join(run.runDir, `${member.name}.log`), "[horde] unparked: another member recorded new work\n");
      await recordLifecycle(run, "member-unparked", { member: member.name });
      refreshRun(run);
      return "continue";
    }
    await sleep(PARK_POLL_MS);
  }
}
