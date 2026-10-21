import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { inboxFor } from "../tool/inbox.js";
import type { PeerMessage } from "../ledger/collaboration.js";
import { recordEvent } from "../ledger/events.js";
import { recordPhase } from "./lifecycle.js";
import { envNumber } from "../format.js";
import { resetMemberState } from "../member.js";
import type { MemberState } from "../member.js";
import { hardStopMembers } from "./controls.js";
import { scheduleCollaboration, stopReason } from "./schedule.js";
import { spawnOne } from "./supervise.js";
import type { RunLaunch } from "./supervise.js";

/**
 * Blockers and independent checks take precedence over administrative exchanges. A request to
 * validate the pending answer decides the run's outcome, so it ranks with the blockers.
 */
function repairPriority(message: PeerMessage): number {
  if (message.blocking || message.target === "answer") return 0;
  if (message.kind === "review-request" && /^[AF]\d+$/.test(message.target)) return 1;
  if (message.state === "responded") return 2;
  return 3;
}

function queueFor(launch: RunLaunch, member: MemberState): PeerMessage[] {
  return inboxFor({ hordeDir: launch.run.hordeDir, runId: launch.run.id, actor: member.name })
    .sort((a, b) => repairPriority(a) - repairPriority(b) || a.createdAt.localeCompare(b.createdAt));
}

/**
 * What a queue costs in floors: one cold session covers the administrative threads in it, and
 * each review request or blocking challenge is an inspect/attach/review cycle of about a floor
 * on its own. A seven-handoff queue and a one-review queue both demand one unit; a queue holding
 * three reviews demands three, so its share is sized to the work rather than to the member.
 */
export function repairDemand(queue: PeerMessage[]): number {
  const checks = queue.filter((m) => m.blocking || m.target === "answer" || (m.kind === "review-request" && /^[AF]\d+$/.test(m.target))).length;
  return Math.max(1, checks);
}

/** The reservation a share is cut from: every pending unit plus up to two correction/recheck turns. */
function reservedUnits(pendingUnits: number, laterRounds: number): number {
  return Math.max(1, pendingUnits) + Math.min(2, Math.max(0, laterRounds));
}

/** This attempt's share of what remains, in proportion to its demand against every pending unit. */
export function repairShare(remaining: number, pendingUnits: number, laterRounds: number, units = 1): number {
  return Math.max(0, Math.floor((remaining * units) / reservedUnits(pendingUnits, laterRounds)));
}

/**
 * The clock is split only among the attempts the token budget can still pay for. Reserving time
 * for members the token floor will skip anyway shrank every attempt to a share nobody could use.
 */
export function repairTimeShare(remainingMs: number, pendingUnits: number, laterRounds: number, fundable: number, units = 1): number {
  const divisor = Math.min(reservedUnits(pendingUnits, laterRounds), Math.max(1, fundable));
  return Math.max(0, Math.min(remainingMs, Math.floor((remainingMs * units) / divisor)));
}

/**
 * A fresh repair session pays the full system prompt, tool schemas, task and queued inbox before
 * it can act: about 20k input+output tokens over five turns on deepseek for a queue of two to
 * four threads, and the better part of a minute to read, inspect, attach and review. A share
 * below either floor is killed before it acts, so each attempt gets at least the floor and
 * lower-priority members go unserved instead.
 */
export function repairAllowance(share: number, remaining: number, floor: number): number | undefined {
  if (remaining < Math.max(1, floor)) return undefined;
  return Math.max(share, floor);
}

export interface RepairFloors {
  tokens: number;
  ms: number;
}

export function repairFloors(): RepairFloors {
  return {
    tokens: Math.max(0, envNumber("PI_HORDE_REPAIR_MIN_TOKENS", 40_000)),
    ms: Math.max(0, envNumber("PI_HORDE_REPAIR_MIN_MS", 60_000)),
  };
}

/** Demand units a default budget funds at the floor; the overrides name flat totals instead. */
const FUNDED_UNITS = 6;

export interface RepairBudget {
  tokens: number;
  ms: number;
  /** Turns per attempt: one that has not finished its inbox read by then will not finish with more. */
  turns: number;
  queued: number;
}

/**
 * Totals follow the queues: one floor per demand unit across the queued members up to
 * `FUNDED_UNITS`, plus the two correction/recheck shares that `repairShare` reserves for later
 * rounds, unless `PI_HORDE_REPAIR_TOKENS` or `PI_HORDE_REPAIR_MS` names a flat total. A flat 50k
 * tokens funded two attempts in an eight-member run and skipped six members with queued work;
 * one floor per member gave a one-review verifier and a seven-thread owner the same 60 seconds.
 */
export function repairBudget(demands: number[], floors: RepairFloors, rounds: number): RepairBudget {
  const units = demands.reduce((sum, demand) => sum + demand, 0);
  const funded = Math.min(Math.max(1, units), FUNDED_UNITS) + Math.min(2, Math.max(0, rounds - 1));
  return {
    tokens: Math.max(0, envNumber("PI_HORDE_REPAIR_TOKENS", floors.tokens * funded)),
    ms: Math.max(0, envNumber("PI_HORDE_REPAIR_MS", floors.ms * funded)),
    turns: Math.max(1, envNumber("PI_HORDE_REPAIR_TURNS", 40)),
    queued: demands.length,
  };
}

type SkipReason = "insufficient-budget" | "insufficient-time";

async function recordSkipped(launch: RunLaunch, pending: MemberState[], reason: SkipReason, detail: Record<string, number>): Promise<void> {
  const { run } = launch;
  const ctx = { hordeDir: run.hordeDir, runId: run.id, actor: "parent", attempt: "scheduler" };
  const members = pending.map((member) => ({ member: member.name, messages: queueFor(launch, member).map((m) => m.id) }))
    .filter((entry) => entry.messages.length);
  if (!members.length) return;
  run.repairSkipped = [...new Set([...(run.repairSkipped ?? []), ...members.map((entry) => entry.member)])];
  await recordEvent(ctx, "repair-skipped", { payload: { reason, ...detail, members } });
}

interface RepairLimits {
  tokens: number;
  turns: number;
}

/** What the attempt's first turn cost, so the token floor can be tuned from data. */
interface FirstTurnCost {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * A finished worker receives a fresh, bounded attempt with a precise evidence handoff. The time
 * share is the allowance recorded and the deadline is derived from it once, so the record cannot
 * read a millisecond under the floor the share was raised to.
 */
async function repairMember(launch: RunLaunch, member: MemberState, ms: number, limits: RepairLimits, floors: RepairFloors): Promise<void> {
  const { run } = launch;
  const ctx = { hordeDir: run.hordeDir, runId: run.id, actor: member.name };
  const queue = queueFor(launch, member);
  if (!queue.length || stopReason(launch)) return;
  const prior = { turns: member.turns, toolCalls: member.toolCalls, usage: { ...member.usage }, startedAt: member.startedAt };
  resetMemberState(member);
  member.repairs = (member.repairs ?? 0) + 1;
  member.repairStopReason = undefined;
  member.attempt = randomUUID();
  const deadline = Date.now() + ms;
  const allowance = { ...limits, ms };
  let firstTurn: FirstTurnCost | undefined;
  member.resetNote = `Repair attempt ${member.repairs}. Discovery is closed. Budget: about ${allowance.tokens} input+output tokens, ${allowance.turns} turns and ${allowance.ms}ms. ` +
    `Read horde inbox and referenced evidence. Work in this priority order: ${queue.map((m) => `${m.id} ${m.target} (${m.state})`).join(", ")}. ` +
    "Handle blockers and artifact reviews before administrative threads. For review requests, independently check the current revision against its artifact kind and criteria and record evidence plus a scoped review. " +
    "For corrections, repair, publish, and respond with the current hash. Requesters recheck and resolve or defer with evidence. Preserve unchecked limits. Do not reopen unrelated work.";
  const spent = (): number => member.usage.input + member.usage.output;
  const halt = (reason: NonNullable<MemberState["repairStopReason"]>) => {
    if (member.repairStopReason) return;
    member.repairStopReason = reason;
    fs.appendFileSync(path.join(run.runDir, `${member.name}.log`), `[horde] repair stop: ${reason}; allowance=${JSON.stringify(allowance)}; observed tokens=${spent()} turns=${member.turns}\n`);
    hardStopMembers(run, [member.name]);
  };
  const check = () => {
    if (firstTurn === undefined && member.turns > 0) {
      const { input, output, cacheRead, cacheWrite } = member.usage;
      firstTurn = { turns: member.turns, input, output, cacheRead, cacheWrite };
    }
    const reason = stopReason(launch);
    if (reason) halt(reason);
    else if (spent() >= allowance.tokens) halt("tokens");
    else if (member.turns >= allowance.turns) halt("turns");
    else if (Date.now() >= deadline) halt("time");
  };
  const timeout = setTimeout(() => halt("time"), Math.max(1, deadline - Date.now()));
  const watchdog = setInterval(check, 100);
  try {
    await recordEvent({ ...ctx, attempt: member.attempt }, "repair-start", { payload: { messages: queue.map((m) => m.id), demand: repairDemand(queue), prior, allowance, floors } });
    if (stopReason(launch) || Date.now() >= deadline) {
      halt(stopReason(launch) ?? "time");
      member.status = "stopped";
      member.endCause = "killed";
      member.endedAt = Date.now();
    } else {
      // Enforce a share on every usage update, rather than waiting for the next poll.
      await spawnOne(launch, member, undefined, check);
    }
    await recordEvent({ ...ctx, attempt: member.attempt }, "repair-end", { payload: {
      cause: member.endCause, stopReason: member.repairStopReason, allowance, usage: member.usage, turns: member.turns, firstTurn,
      messages: queue.map((m) => m.id),
    } });
  } finally {
    clearTimeout(timeout);
    clearInterval(watchdog);
    run.repairTokens = (run.repairTokens ?? 0) + spent();
    member.turns += prior.turns;
    member.toolCalls += prior.toolCalls;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) member.usage[key] += prior.usage[key];
    member.startedAt = prior.startedAt;
  }
}

/** Run after discovery exits and before cleanup. Forced/user stops retain unresolved debt. */
export async function drainRepairs(launch: RunLaunch): Promise<void> {
  const { run } = launch;
  let started = false;
  // The repair phase is recorded only once an attempt or a budget refusal actually happens.
  const begin = async (budget: RepairBudget): Promise<void> => {
    if (started) return;
    started = true;
    await recordPhase(run, "repair", "start", { budget });
  };
  try {
    await runRepairRounds(launch, begin);
  } finally {
    if (started) await recordPhase(run, "repair", "end", { tokens: run.repairTokens ?? 0 });
  }
}

function eligibleMembers(launch: RunLaunch): Array<{ member: MemberState; queue: PeerMessage[] }> {
  return launch.run.members.map((member) => ({ member, queue: queueFor(launch, member) })).filter((entry) => entry.queue.length)
    .sort((a, b) => repairPriority(a.queue[0]!) - repairPriority(b.queue[0]!) ||
      (a.member.repairs ?? 0) - (b.member.repairs ?? 0) || a.queue[0]!.createdAt.localeCompare(b.queue[0]!.createdAt));
}

async function runRepairRounds(launch: RunLaunch, begin: (budget: RepairBudget) => Promise<void>): Promise<void> {
  const { run } = launch;
  const rounds = Math.max(0, Math.min(6, envNumber("PI_HORDE_REPAIR_ROUNDS", 4)));
  if (rounds === 0 || stopReason(launch)) return;
  const floors = repairFloors();
  await scheduleCollaboration(launch, { settleMs: 0, liveOnly: false });
  const budget = repairBudget(eligibleMembers(launch).map((entry) => repairDemand(entry.queue)), floors, rounds);
  if (budget.queued === 0) return;
  const deadline = Date.now() + budget.ms;
  const exhausted = () => stopReason(launch) || Date.now() >= deadline || (run.repairTokens ?? 0) >= budget.tokens;
  for (let round = 0; round < rounds; round++) {
    if (exhausted()) return;
    if (round > 0) await scheduleCollaboration(launch, { settleMs: 0, liveOnly: false });
    // One attempt per member per round, picked in priority order re-read before each attempt:
    // a thread that became blocking during an attempt moves its recipient ahead of the
    // administrative queues that were ordered first at round start.
    const served = new Set<string>();
    for (;;) {
      if (exhausted()) return;
      const pending = eligibleMembers(launch).filter((entry) => !served.has(entry.member.name));
      if (!pending.length) break;
      const next = pending[0]!;
      const pendingUnits = pending.reduce((sum, entry) => sum + repairDemand(entry.queue), 0);
      const units = repairDemand(next.queue);
      const unserved = pending.map((entry) => entry.member);
      const remaining = budget.tokens - (run.repairTokens ?? 0);
      const laterRounds = rounds - round - 1;
      const tokens = repairAllowance(repairShare(remaining, pendingUnits, laterRounds, units), remaining, floors.tokens);
      if (tokens === undefined) {
        await begin(budget);
        await recordSkipped(launch, unserved, "insufficient-budget", { remaining, floor: floors.tokens });
        return;
      }
      const remainingMs = Math.max(0, deadline - Date.now());
      const fundable = Math.floor(remaining / Math.max(1, floors.tokens));
      const ms = repairAllowance(repairTimeShare(remainingMs, pendingUnits, laterRounds, fundable, units), remainingMs, floors.ms);
      if (ms === undefined || ms < 1) {
        await begin(budget);
        await recordSkipped(launch, unserved, "insufficient-time", { remainingMs, floorMs: floors.ms });
        return;
      }
      await begin(budget);
      served.add(next.member.name);
      await repairMember(launch, next.member, ms, { tokens, turns: budget.turns }, floors);
    }
  }
}
