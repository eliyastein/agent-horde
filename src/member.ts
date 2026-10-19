import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { oneLine } from "./format.js";

export type MemberStatus = "starting" | "running" | "done" | "failed" | "stopped";

export type MemberEndCause =
  | "completed"
  | "model_error"
  | "no_output"
  | "killed"
  | "exit_nonzero"
  | "unknown";

export interface MemberUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface MemberState {
  attempt?: string;
  repairs?: number;
  repairStopReason?: "tokens" | "turns" | "time" | "user-stop" | "disposed" | "master-abort";
  name: string;
  index: number;
  status: MemberStatus;
  currentTool?: string | undefined;
  currentArg?: string | undefined;
  streaming?: "text" | "thinking" | undefined;
  turns: number;
  toolCalls: number;
  usage: MemberUsage;
  lastText: string;
  finalText: string;
  /** In-progress assistant text retained if termination interrupts the final message. */
  draftText?: string | undefined;
  /** Last child event, used to give active final writers a short stop extension. */
  lastActivityAt?: number | undefined;
  startedAt: number;
  endedAt?: number | undefined;
  exitCode?: number | undefined;
  error?: string | undefined;
  paused?: boolean | undefined;
  /** Why the member process ended, for run diagnosis. */
  endCause?: MemberEndCause | undefined;
  /** True when the member ended abnormally after doing measurable work. */
  partial?: boolean | undefined;
  /** True when the member was killed before producing a complete final summary. */
  summaryIncomplete?: boolean | undefined;
  /** How many fresh-context sessions replaced this member's earlier ones. */
  resets?: number | undefined;
  /** Set by the parent before it kills a stalled member, so the exit is treated as a reset. */
  resetPending?: string | undefined;
  /** Extra identity line for a replacement session, naming what was reset and why. */
  resetNote?: string | undefined;
}

/** One fresh-context reset of a member, kept for the run report. */
export interface MemberReset {
  member: string;
  reason: string;
  at: number;
  /** Ideas returned to the open pool because no finding of the dead session closed them. */
  released: number[];
  /** Ideas closed because a finding of the dead session referenced them. */
  closed: number[];
  turns: number;
  toolCalls: number;
  tokens: number;
}

export interface MemberRunInfo {
  id: string;
  hordeDir: string;
  runDir: string;
  prompt: string;
  count: number;
}

interface SpawnMemberInput {
  member: MemberState;
  run: MemberRunInfo;
  cwd: string;
  model?: { provider: string; id: string } | undefined;
  thinkingLevel?: string | undefined;
  approve: boolean;
  signal: AbortSignal;
  onChange: () => void;
  /** Extra per-member instruction, e.g. an assigned workstream or verifier role. */
  role?: string | undefined;
  onSpawn?: (proc: ChildProcess) => void;
  onExit?: () => void;
  /** Called once when the member produces its first token or assistant event. */
  onFirstOutput?: () => void;
}

const LAST_TEXT_CHARS = 80;
const STDERR_TAIL_LINES = 20;
const KILL_GRACE_MS = 5_000;

/** Every pi child this parent has spawned and not yet seen exit. */
const liveChildren = new Set<ChildProcess>();

function isRunning(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

function trackChild(proc: ChildProcess): void {
  liveChildren.add(proc);
  proc.once("close", () => liveChildren.delete(proc));
}

/**
 * Ask a child to exit: wake it if it is suspended, send SIGTERM so pi can kill
 * its own bash children and dispose its session, and SIGKILL it if it is still
 * there after the grace period. `proc.killed` only means a signal was sent, so
 * exitCode/signalCode gate the escalation.
 */
function terminateChild(proc: ChildProcess, graceMs = KILL_GRACE_MS): void {
  if (!isRunning(proc)) return;
  if (process.platform !== "win32") proc.kill("SIGCONT");
  proc.kill("SIGTERM");
  const escalate = setTimeout(() => {
    if (isRunning(proc)) proc.kill("SIGKILL");
  }, graceMs);
  escalate.unref();
  proc.once("close", () => clearTimeout(escalate));
}

/**
 * Send SIGTERM to every live child. Runs from the parent's `exit` event, which
 * pi's crash paths reach without emitting `session_shutdown`, so it must stay
 * synchronous: no escalation timer can fire once the parent is gone, and the
 * children's own parent watchdog finishes the job.
 */
export function terminateAllChildren(): number {
  let signalled = 0;
  for (const proc of liveChildren) {
    if (!isRunning(proc)) continue;
    try {
      if (process.platform !== "win32") proc.kill("SIGCONT");
      proc.kill("SIGTERM");
      signalled++;
    } catch {
      // Already gone.
    }
  }
  return signalled;
}

/** Number of spawned pi children that have not exited yet. */
export function liveChildCount(): number {
  let count = 0;
  for (const proc of liveChildren) if (isRunning(proc)) count++;
  return count;
}

/** Environment every pi child gets so it can watch this process and exit with it. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PI_HORDE_PARENT_PID: String(process.pid), ...extra };
}

interface ExecPiOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
}

interface ExecPiResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a one-shot pi helper (post-mortem, deliverable) and capture its output.
 * Unlike `pi.exec`, this passes an environment, escalates to SIGKILL after a
 * timeout or abort, and is tracked for parent-exit cleanup. Never rejects.
 */
export function execPi(
  invocation: { command: string; args: string[] },
  options: ExecPiOptions,
): Promise<ExecPiResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const proc = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
    });
    trackChild(proc);
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (data: string) => {
      stdout += data;
    });
    proc.stderr.on("data", (data: string) => {
      stderr += data;
    });
    const stop = (): void => terminateChild(proc);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timer.unref();
    if (options.signal.aborted) stop();
    else options.signal.addEventListener("abort", stop, { once: true });
    proc.on("error", (error) => {
      stderr += `${error.message}\n`;
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export function newMemberState(index: number): MemberState {
  return {
    name: `member-${index}`,
    index,
    status: "starting",
    turns: 0,
    toolCalls: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    lastText: "",
    finalText: "",
    startedAt: Date.now(),
  };
}

/** Reset a member to its initial state so it can be respawned (canary retry, stall reset). */
export function resetMemberState(member: MemberState): void {
  member.status = "starting";
  member.resetPending = undefined;
  member.attempt = randomUUID();
  member.turns = 0;
  member.toolCalls = 0;
  member.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  member.lastText = "";
  member.finalText = "";
  member.draftText = undefined;
  member.lastActivityAt = undefined;
  member.currentTool = undefined;
  member.currentArg = undefined;
  member.streaming = undefined;
  member.error = undefined;
  member.endCause = undefined;
  member.partial = undefined;
  member.summaryIncomplete = undefined;
  member.exitCode = undefined;
  member.endedAt = undefined;
  member.paused = false;
  member.startedAt = Date.now();
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

/** Directory holding one member's pi session file(s): `<runDir>/sessions/<member>`. */
export function memberSessionDir(runDir: string, member: string): string {
  return path.join(runDir, "sessions", member);
}

/** The per-member system line: name, assigned role, and a reset note for a replacement. */
function identityLine(member: MemberState, role: string | undefined): string {
  const parts = [`You are ${member.name}.`];
  if (role) parts.push(role);
  if (member.resetNote) parts.push(member.resetNote);
  return parts.join(" ");
}

export function buildMemberArgs(input: SpawnMemberInput): string[] {
  const { run, member } = input;
  const args = [
    "--mode", "json", "-p",
    "--session-dir", memberSessionDir(run.runDir, member.name),
    "--append-system-prompt", path.join(run.runDir, "SYSTEM.md"),
    "--append-system-prompt", identityLine(member, input.role),
  ];
  if (input.model) args.push("--model", `${input.model.provider}/${input.model.id}`);
  if (input.thinkingLevel) args.push("--thinking", input.thinkingLevel);
  if (input.approve) args.push("--approve");
  args.push("--", run.prompt);
  return args;
}

export function memberEnv(input: SpawnMemberInput): NodeJS.ProcessEnv {
  return childEnv({
    PI_HORDE_MEMBER: "1",
    PI_HORDE_DIR: input.run.hordeDir,
    PI_HORDE_NAME: input.member.name,
    PI_HORDE_RUN: input.run.id,
    PI_HORDE_ROLE: input.role ?? "",
    PI_HORDE_ATTEMPT: input.member.attempt ??= randomUUID(),
  });
}

export function splitNdjson(buffer: string, onLine: (line: string) => void): string {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) if (line.trim()) onLine(line);
  return remainder;
}

export function summarizeToolArg(toolName: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const str = (key: string): string => {
    const value = record[key];
    return typeof value === "string" ? value : "";
  };
  switch (toolName) {
    case "bash":
      return str("command");
    case "grep":
      return str("path") ? `${str("pattern")} in ${str("path")}` : str("pattern");
    case "horde":
      return typeof record.id === "number" ? `${str("action")} #${record.id}` : str("action");
    default: {
      const firstString = Object.values(record).find((v) => typeof v === "string");
      return str("path") || str("pattern") || (firstString as string | undefined) || "";
    }
  }
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object")
    .filter((part) => (part as { type?: string }).type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

function applyAssistantMessageEnd(member: MemberState, message: Record<string, unknown>): void {
  member.turns++;
  member.streaming = undefined;
  const usage = (message.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  member.usage.input += num(usage.input);
  member.usage.output += num(usage.output);
  member.usage.cacheRead += num(usage.cacheRead);
  member.usage.cacheWrite += num(usage.cacheWrite);
  member.usage.cost += num((usage.cost as Record<string, unknown> | undefined)?.total);
  const text = messageText(message);
  if (text.trim()) {
    member.finalText = text;
    member.lastText = oneLine(text.slice(-LAST_TEXT_CHARS * 2), LAST_TEXT_CHARS);
  }
  member.draftText = undefined;
  if (message.stopReason === "error") {
    member.error = typeof message.errorMessage === "string" ? message.errorMessage : "model error";
  }
}

export function applyEvent(member: MemberState, event: Record<string, unknown>): void {
  member.lastActivityAt = Date.now();
  const message = (event.message ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "agent_start":
      member.status = "running";
      return;
    case "message_start":
      if (message.role === "assistant") {
        member.currentTool = undefined;
        member.streaming = undefined;
        member.lastText = "";
        member.draftText = undefined;
      }
      return;
    case "message_update": {
      const delta = (event.assistantMessageEvent ?? {}) as Record<string, unknown>;
      if (delta.type === "text_delta") {
        member.streaming = "text";
        const chunk = typeof delta.delta === "string" ? delta.delta : "";
        member.draftText = `${member.draftText ?? ""}${chunk}`.slice(-8000);
        const combined = `${member.lastText}${chunk}`;
        member.lastText = oneLine(combined.slice(-LAST_TEXT_CHARS * 2), LAST_TEXT_CHARS);
      } else if (delta.type === "thinking_delta") {
        member.streaming = "thinking";
      }
      return;
    }
    case "message_end":
      if (message.role === "assistant") applyAssistantMessageEnd(member, message);
      return;
    case "tool_execution_start":
      member.toolCalls++;
      member.streaming = undefined;
      member.currentTool = typeof event.toolName === "string" ? event.toolName : "tool";
      member.currentArg = oneLine(summarizeToolArg(member.currentTool, event.args), 40);
      return;
    case "tool_execution_end":
      member.currentTool = undefined;
      member.currentArg = undefined;
      return;
    default:
      return;
  }
}

/** What a `member-N.log` records about the member's end, for runs no longer in memory. */
interface MemberLogSummary {
  status?: MemberStatus | undefined;
  exitCode?: number | undefined;
  endCause?: MemberEndCause | undefined;
  partial: boolean;
  turns?: number | undefined;
  toolCalls?: number | undefined;
  final?: string | undefined;
  spawnErrors: string[];
  /** Reasons of every fresh-context reset, in order. */
  resets: string[];
}

const LOG_EXIT_LINE = /^\[horde\] exit code (\d+) status (\w+)(?: cause (\w+))?( partial)?$/;
const LOG_TURNS_LINE = /^\[horde\] turns (\d+) toolCalls (\d+)$/;
const LOG_RESET_LINE = /^\[horde\] reset \d+: (.+)$/;

/** Parse the `[horde]` lifecycle lines that `spawnMember` writes to `member-N.log`. */
export function parseMemberLog(content: string): MemberLogSummary {
  const summary: MemberLogSummary = { partial: false, spawnErrors: [], resets: [] };
  for (const line of content.split("\n")) {
    const reset = LOG_RESET_LINE.exec(line);
    if (reset) {
      summary.resets.push(reset[1] ?? "");
      continue;
    }
    const exit = LOG_EXIT_LINE.exec(line);
    if (exit) {
      summary.exitCode = Number(exit[1]);
      summary.status = exit[2] as MemberStatus;
      summary.endCause = exit[3] as MemberEndCause | undefined;
      summary.partial = exit[4] !== undefined;
      continue;
    }
    const turns = LOG_TURNS_LINE.exec(line);
    if (turns) {
      summary.turns = Number(turns[1]);
      summary.toolCalls = Number(turns[2]);
      continue;
    }
    if (line.startsWith("[horde] final: ")) summary.final = line.slice("[horde] final: ".length);
    else if (line.startsWith("[horde] spawn error: ")) summary.spawnErrors.push(line);
  }
  return summary;
}

function stderrTail(text: string): string {
  return text.trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
}

function finishMember(
  member: MemberState,
  code: number | null,
  aborted: boolean,
  stderr: string,
): void {
  member.endedAt = Date.now();
  member.exitCode = code ?? 1;
  member.currentTool = undefined;
  member.currentArg = undefined;
  member.streaming = undefined;
  member.paused = false;
  if (aborted) {
    member.status = "stopped";
  } else if (member.exitCode === 0 && !member.error) {
    member.status = "done";
  } else {
    member.status = "failed";
    member.error = member.error || stderrTail(stderr) || `exit code ${member.exitCode}`;
  }
  member.endCause = computeEndCause(member, aborted);
  // A turn alone is not work: a killed member that produced no tokens, no tool
  // calls, and no text has nothing worth keeping as a partial result.
  const producedWork =
    member.toolCalls > 0 || member.usage.output > 0 || member.finalText.trim() !== "" || Boolean(member.draftText?.trim());
  member.partial = member.endCause !== "completed" && producedWork;
  member.summaryIncomplete = aborted ? true : undefined;
}

function computeEndCause(member: MemberState, aborted: boolean): MemberEndCause {
  if (aborted) return "killed";
  if (member.error) return "model_error";
  if (member.exitCode !== 0) return "exit_nonzero";
  if (member.usage.input + member.usage.output === 0) return "no_output";
  return "completed";
}

/**
 * Spawn one horde member as a child pi process and reduce its JSON event stream
 * into `input.member`. Resolves when the process exits; never rejects.
 */
export function spawnMember(input: SpawnMemberInput): Promise<void> {
  const { member, signal, onChange } = input;
  const logPath = path.join(input.run.runDir, `${member.name}.log`);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  // A failed log open emits 'error' asynchronously; without a listener that
  // becomes an uncaughtException that kills the parent pi session.
  log.on("error", () => {});
  const invocation = getPiInvocation(buildMemberArgs(input));
  log.write(`[horde] spawn: ${invocation.command} ${JSON.stringify(invocation.args)}\n`);

  return new Promise((resolve) => {
    let stdoutBuffer = "";
    let stderrText = "";
    let aborted = false;
    let firstOutputSeen = false;
    const proc = spawn(invocation.command, invocation.args, {
      cwd: input.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: memberEnv(input),
    });
    trackChild(proc);
    input.onSpawn?.(proc);

    const handleLine = (line: string): void => {
      try {
        applyEvent(member, JSON.parse(line) as Record<string, unknown>);
        if (
          !firstOutputSeen &&
          (member.usage.input + member.usage.output > 0 || member.streaming !== undefined)
        ) {
          firstOutputSeen = true;
          input.onFirstOutput?.();
        }
        onChange();
      } catch {
        log.write(`[horde] unparseable stdout line: ${line}\n`);
      }
    };

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (data: string) => {
      stdoutBuffer = splitNdjson(stdoutBuffer + data, handleLine);
    });
    proc.stderr.on("data", (data: string) => {
      stderrText += data;
      log.write(data);
    });
    proc.on("error", (error) => {
      member.error = error.message;
      log.write(`[horde] spawn error: ${error.message}\n`);
    });
    proc.on("close", (code) => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      finishMember(member, code, aborted, stderrText);
      log.write(
        `[horde] exit code ${member.exitCode} status ${member.status} cause ${member.endCause}` +
          `${member.partial ? " partial" : ""}\n`,
      );
      log.write(`[horde] turns ${member.turns} toolCalls ${member.toolCalls}\n`);
      const retainedFinal = member.summaryIncomplete
        ? (member.draftText?.trim() || member.finalText.trim())
        : (member.finalText.trim() || member.draftText?.trim() || "");
      if (retainedFinal) {
        log.write(`[horde] final: ${oneLine(retainedFinal, 1000)}\n`);
      }
      // Resolve only once the log is flushed (or has errored), so a parent that
      // appends its own lines to member-N.log after the exit keeps them in order.
      log.end(() => {
        input.onExit?.();
        onChange();
        resolve();
      });
    });

    const kill = (): void => {
      aborted = true;
      terminateChild(proc);
    };
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });
  });
}
