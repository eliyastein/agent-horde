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

/** Blockers and independent checks take precedence over administrative exchanges. */
function repairPriority(message: PeerMessage): number {
  if (message.blocking) return 0;
  if (message.kind === "review-request" && /^[AF]\d+$/.test(message.target)) return 1;
  if (message.state === "responded") return 2;
  return 3;
}

function queueFor(launch: RunLaunch, member: MemberState): PeerMessage[] {
  return inboxFor({ hordeDir: launch.run.hordeDir, runId: launch.run.id, actor: member.name })
    .sort((a, b) => repairPriority(a) - repairPriority(b) || a.createdAt.localeCompare(b.createdAt));
}

/** Reserve shares for the other queued members and up to two correction/recheck turns. */
export function repairShare(remaining: number, queued: number, laterRounds: number): number {
  return Math.max(0, Math.floor(remaining / (Math.max(1, queued) + Math.min(2, Math.max(0, laterRounds)))));
}

/**
 * A fresh repair session pays the full system prompt, tool schemas and task on its first turn
 * (about 8k uncached tokens on deepseek). A share below that is killed before it can act, so each
 * attempt gets at least the floor and lower-priority members go unserved instead.
 */
function repairAllowance(share: number, remaining: number, floor: number): number | undefined {
  if (remaining < Math.max(1, floor)) return undefined;
  return Math.max(share, floor);
}

async function recordSkipped(launch: RunLaunch, pending: MemberState[], detail: Record<string, number>): Promise<void> {
  const { run } = launch;
  const ctx = { hordeDir: run.hordeDir, runId: run.id, actor: "parent", attempt: "scheduler" };
  const members = pending.map((member) => ({ member: member.name, messages: queueFor(launch, member).map((m) => m.id) }))
    .filter((entry) => entry.messages.length);
  if (members.length) await recordEvent(ctx, "repair-skipped", { payload: { reason: "insufficient-budget", ...detail, members } });
}

/** A finished worker receives a fresh, bounded attempt with a precise evidence handoff. */
async function repairMember(launch: RunLaunch, member: MemberState, deadline: number, tokens: number): Promise<void> {
  const { run } = launch;
  const ctx = { hordeDir: run.hordeDir, runId: run.id, actor: member.name };
  const queue = queueFor(launch, member);
  if (!queue.length || stopReason(launch)) return;
  const prior = { turns: member.turns, toolCalls: member.toolCalls, usage: { ...member.usage }, startedAt: member.startedAt };
  resetMemberState(member);
  member.repairs = (member.repairs ?? 0) + 1;
  member.repairStopReason = undefined;
  member.attempt = randomUUID();
  const allowance = { tokens, ms: Math.max(0, deadline - Date.now()) };
  member.resetNote = `Repair attempt ${member.repairs}. Discovery is closed. Budget: about ${tokens} input+output tokens and ${allowance.ms}ms. ` +
    `Read horde inbox and referenced evidence. Work in this priority order: ${queue.map((m) => `${m.id} ${m.target} (${m.state})`).join(", ")}. ` +
    "Handle blockers and artifact reviews before administrative threads. For review requests, independently check the current revision against its artifact kind and criteria and record evidence plus a scoped review. " +
    "For corrections, acknowledge, repair, publish, and respond with the current hash. Requesters recheck and resolve or defer with evidence. Preserve unchecked limits. Do not reopen unrelated work.";
  const halt = (reason: NonNullable<MemberState["repairStopReason"]>) => {
    if (member.repairStopReason) return;
    member.repairStopReason = reason;
    fs.appendFileSync(path.join(run.runDir, `${member.name}.log`), `[horde] repair stop: ${reason}; allowance=${JSON.stringify(allowance)}; observed tokens=${member.usage.input + member.usage.output}\n`);
    hardStopMembers(run, [member.name]);
  };
  const check = () => {
    const reason = stopReason(launch);
    if (reason) halt(reason);
    else if (member.usage.input + member.usage.output >= tokens) halt("tokens");
    else if (Date.now() >= deadline) halt("time");
  };
  const timeout = setTimeout(() => halt("time"), Math.max(1, deadline - Date.now()));
  const watchdog = setInterval(check, 100);
  try {
    await recordEvent({ ...ctx, attempt: member.attempt }, "repair-start", { payload: { messages: queue.map((m) => m.id), prior, allowance } });
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
      cause: member.endCause, stopReason: member.repairStopReason, allowance, usage: member.usage, messages: queue.map((m) => m.id),
    } });
  } finally {
    clearTimeout(timeout);
    clearInterval(watchdog);
    run.repairTokens = (run.repairTokens ?? 0) + member.usage.input + member.usage.output;
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
  const begin = async (): Promise<void> => {
    if (started) return;
    started = true;
    await recordPhase(run, "repair", "start");
  };
  try {
    await runRepairRounds(launch, begin);
  } finally {
    if (started) await recordPhase(run, "repair", "end", { tokens: run.repairTokens ?? 0 });
  }
}

async function runRepairRounds(launch: RunLaunch, begin: () => Promise<void>): Promise<void> {
  const { run } = launch;
  const rounds = Math.max(0, Math.min(6, envNumber("PI_HORDE_REPAIR_ROUNDS", 4)));
  const deadline = Date.now() + Math.max(0, envNumber("PI_HORDE_REPAIR_MS", 120_000));
  const tokenLimit = Math.max(0, envNumber("PI_HORDE_REPAIR_TOKENS", 50_000));
  const tokenFloor = Math.max(0, envNumber("PI_HORDE_REPAIR_MIN_TOKENS", 20_000));
  const exhausted = () => stopReason(launch) || Date.now() >= deadline || (run.repairTokens ?? 0) >= tokenLimit;
  for (let round = 0; round < rounds; round++) {
    if (exhausted()) return;
    await scheduleCollaboration(launch, { settleMs: 0, liveOnly: false });
    const eligible = run.members.map((member) => ({ member, queue: queueFor(launch, member) })).filter((entry) => entry.queue.length)
      .sort((a, b) => repairPriority(a.queue[0]!) - repairPriority(b.queue[0]!) ||
        (a.member.repairs ?? 0) - (b.member.repairs ?? 0) || a.queue[0]!.createdAt.localeCompare(b.queue[0]!.createdAt));
    if (!eligible.length) return;
    // Sequential attempts preserve owner -> reviewer ordering while reserving others' shares.
    for (let index = 0; index < eligible.length; index++) {
      if (exhausted()) return;
      const pending = eligible.slice(index).filter(({ member }) => queueFor(launch, member).length);
      const remaining = tokenLimit - (run.repairTokens ?? 0);
      const tokens = repairAllowance(repairShare(remaining, pending.length, rounds - round - 1), remaining, tokenFloor);
      const ms = repairShare(deadline - Date.now(), pending.length, rounds - round - 1);
      if (tokens === undefined) {
        await begin();
        await recordSkipped(launch, pending.map((entry) => entry.member), { remaining, floor: tokenFloor });
        return;
      }
      if (ms < 1) break;
      await begin();
      await repairMember(launch, eligible[index]!.member, Date.now() + ms, tokens);
    }
  }
}
