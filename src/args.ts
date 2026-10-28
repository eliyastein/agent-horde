export const MAX_MEMBERS = 12;

/** Hordes per swarm; `H/M` launches H hordes of M members. */
export const MAX_HORDES = 4;

export const USAGE = [
  "usage: /agent-horde [--dashboard[=<port>]] [--no-verifier] [--until-stop] <count> <prompt>",
  "                                          spawn <count> members with the same prompt;",
  "                                          <count> may be H/M: H hordes of M members, the",
  "                                          task partitioned between the hordes by a planner",
  "       /agent-horde status [target]       show the active run",
  "       /agent-horde stop-hard [target]    terminate members now (SIGTERM, then SIGKILL)",
  "       /agent-horde stop-clean [target]   let members wrap up, then reconcile their ideas",
  "       /agent-horde stop-clean postmortem [target] [--grace <s>]",
  "                                          additionally run a post-mortem on the run",
  "       /agent-horde pause [target]        suspend members (SIGSTOP)",
  "       /agent-horde resume [target]       resume suspended members (SIGCONT)",
  `       /agent-horde plan [--dashboard] <count> <a; b; ...>`,
  "                                          partition members across workstreams; with H/M",
  "                                          the layers go round-robin to the hordes",
  "       /agent-horde help                  show this text",
  "",
  "target is 'all' (default), 'member-N', 'N', 'hN' (one horde), 'hN:member-M', 'hN:M', or a",
  "comma/space separated list; a bare member names that member in every horde.",
  `count is a whole number from 1 to ${MAX_MEMBERS}, or H/M with H from 1 to ${MAX_HORDES}`,
  "--dashboard serves a read-only localhost dashboard (default port 7433, or",
  "PI_HORDE_DASHBOARD_PORT); --dashboard=<port> picks the port.",
  "--no-verifier skips the default verifier role that runs of 3 or more members assign",
  "to their last member.",
  "--until-stop keeps the whole horde working until you run stop-clean or stop-hard: a",
  "validated solve is banked as the current answer and a member that finishes gets a fresh",
  "session told to add new ideas.",
].join("\n");

/** One token of a control target: a horde, a member in every horde, or a member of one horde. */
export interface TargetItem {
  /** 1-based horde index (`h2`); absent for every horde. */
  horde?: number;
  /** `member-N`; absent for every member of the horde. */
  member?: string;
}

/** Which hordes and members a control command applies to. */
export type HordeTarget =
  | { kind: "all" }
  | { kind: "selection"; items: TargetItem[] };

type HordeStopMode = "hard" | "clean";

/** The `--dashboard[=<port>]` launch flag; `port` is undefined for the default. */
export interface DashboardOption {
  port?: number | undefined;
}

type HordeArgs =
  | { kind: "usage"; error?: string }
  | { kind: "help" }
  | { kind: "status"; target: HordeTarget }
  | { kind: "stop"; mode: HordeStopMode; target: HordeTarget; postmortem: boolean; graceMs?: number | undefined }
  | { kind: "pause"; target: HordeTarget }
  | { kind: "resume"; target: HordeTarget }
  | {
      kind: "run";
      /** Concurrent hordes; `12` is one horde, `3/12` three. */
      hordes: number;
      /** Members per horde. */
      count: number;
      prompt: string;
      plan?: string[] | undefined;
      dashboard?: DashboardOption | undefined;
      /** Present (true) only when `--no-verifier` was given. */
      noVerifier?: boolean | undefined;
      /** Present (true) only when `--until-stop` was given. */
      untilStop?: boolean | undefined;
    };

export type HordeRunArgs = Extract<HordeArgs, { kind: "run" }>;

const HORDE_TOKEN = /^h(\d+)$/i;
const MEMBER_TOKEN = /^(?:member-)?(\d+)$/i;

function memberName(token: string): string | undefined {
  const match = MEMBER_TOKEN.exec(token);
  if (!match) return undefined;
  const index = Number(match[1]);
  return index >= 1 && index <= MAX_MEMBERS ? `member-${index}` : undefined;
}

function hordeIndex(token: string): number | undefined {
  const match = HORDE_TOKEN.exec(token);
  if (!match) return undefined;
  const index = Number(match[1]);
  return index >= 1 && index <= MAX_HORDES ? index : undefined;
}

/** `h2`, `h2:member-3`, `h2:3`, `member-3`, or `3`; undefined for anything else. */
function parseTargetItem(token: string): TargetItem | undefined {
  const colon = token.indexOf(":");
  if (colon === -1) {
    const horde = hordeIndex(token);
    if (horde !== undefined) return { horde };
    const member = memberName(token);
    return member === undefined ? undefined : { member };
  }
  const horde = hordeIndex(token.slice(0, colon));
  const member = memberName(token.slice(colon + 1));
  return horde === undefined || member === undefined ? undefined : { horde, member };
}

function parseTargets(raw: string): HordeTarget | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "all" };
  const items: TargetItem[] = [];
  for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
    if (token.toLowerCase() === "all") return { kind: "all" };
    const item = parseTargetItem(token);
    if (!item) return undefined;
    items.push(item);
  }
  return items.length > 0 ? { kind: "selection", items } : { kind: "all" };
}

const TARGET_ERROR = "invalid target; use all, member-N, N, hN, or hN:member-M";

function parseStopRest(
  rest: string,
  mode: HordeStopMode,
):
  | { target: HordeTarget; postmortem: boolean; graceMs?: number | undefined }
  | { error: string } {
  let text = ` ${rest} `;
  let graceMs: number | undefined;
  const graceMatch = /(?:^|\s)--grace(?:=|\s+)(\d+)(?=\s|$)/.exec(text);
  if (graceMatch) {
    const seconds = Number(graceMatch[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) return { error: "invalid --grace; use --grace <seconds>" };
    graceMs = seconds * 1000;
    text = text.replace(graceMatch[0], " ");
  }
  if (/--grace/.test(text)) return { error: "invalid --grace; use --grace <seconds>" };

  let postmortem = false;
  const postMatch = /(?:^|\s)postmortem(?=\s|$)/.exec(text);
  if (postMatch) {
    if (mode !== "clean") return { error: "postmortem is only valid with stop-clean" };
    postmortem = true;
    text = text.replace(postMatch[0], " ");
  }

  const target = parseTargets(text.trim());
  if (!target) return { error: TARGET_ERROR };
  return { target, postmortem, graceMs };
}

const DASHBOARD_FLAG = /^--dashboard(?:=(\S*))?(?=\s|$)/;
const NO_VERIFIER_FLAG = /^--no-verifier(?=\s|$)/;
const UNTIL_STOP_FLAG = /^--until-stop(?=\s|$)/;
const DASHBOARD_ERROR = "invalid --dashboard; use --dashboard or --dashboard=<port 1-65535>";

/** Launch flags found at one position of the command; `rest` is the remaining text. */
interface LaunchFlags {
  rest: string;
  dashboard?: DashboardOption | undefined;
  noVerifier?: boolean | undefined;
  untilStop?: boolean | undefined;
  error?: string | undefined;
}

function parseDashboardFlag(port: string | undefined): DashboardOption | { error: string } {
  if (port === undefined) return {};
  if (!/^\d+$/.test(port)) return { error: DASHBOARD_ERROR };
  const value = Number(port);
  if (value < 1 || value > 65_535) return { error: DASHBOARD_ERROR };
  return { port: value };
}

/** Strip leading `--dashboard[=<port>]`, `--no-verifier`, and `--until-stop` tokens, in any order. */
function takeLaunchFlags(text: string): LaunchFlags {
  const flags: LaunchFlags = { rest: text.trim() };
  for (;;) {
    const dashboard = DASHBOARD_FLAG.exec(flags.rest);
    if (dashboard) {
      const option = parseDashboardFlag(dashboard[1]);
      if ("error" in option) return { ...flags, error: option.error };
      flags.dashboard = option;
      flags.rest = flags.rest.slice(dashboard[0].length).trim();
      continue;
    }
    const noVerifier = NO_VERIFIER_FLAG.exec(flags.rest);
    if (noVerifier) {
      flags.noVerifier = true;
      flags.rest = flags.rest.slice(noVerifier[0].length).trim();
      continue;
    }
    const untilStop = UNTIL_STOP_FLAG.exec(flags.rest);
    if (untilStop) {
      flags.untilStop = true;
      flags.rest = flags.rest.slice(untilStop[0].length).trim();
      continue;
    }
    return flags;
  }
}

/** Flags given before the subcommand or count win over the same flag given after it. */
function mergeLaunchFlags(leading: LaunchFlags, trailing: LaunchFlags): LaunchFlags {
  return {
    rest: trailing.rest,
    dashboard: leading.dashboard ?? trailing.dashboard,
    noVerifier: leading.noVerifier === true || trailing.noVerifier === true ? true : undefined,
    untilStop: leading.untilStop === true || trailing.untilStop === true ? true : undefined,
    error: leading.error ?? trailing.error,
  };
}

const COUNT_ERROR =
  `count must be a whole number from 1 to ${MAX_MEMBERS}, or H/M with H from 1 to ${MAX_HORDES} hordes`;

interface CountedRun {
  hordes: number;
  count: number;
  rest: string;
  flags: LaunchFlags;
}

/** Parse `<count> [flags] <tail>`, where count is `M` or `H/M`. */
function parseCountedRun(text: string, leading: LaunchFlags): CountedRun | { error: string } {
  const match = /^(?:(\d+)\/)?(\d+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return { error: COUNT_ERROR };
  const hordes = match[1] === undefined ? 1 : Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || count > MAX_MEMBERS || hordes < 1 || hordes > MAX_HORDES) return { error: COUNT_ERROR };
  const flags = mergeLaunchFlags(leading, takeLaunchFlags(match[3] ?? ""));
  if (flags.error) return { error: flags.error };
  return { hordes, count, rest: flags.rest, flags };
}

function runArgs(parsed: CountedRun, prompt: string, plan?: string[]): HordeRunArgs {
  const { hordes, count, flags } = parsed;
  const args: HordeRunArgs = { kind: "run", hordes, count, prompt };
  if (plan) args.plan = plan;
  if (flags.dashboard) args.dashboard = flags.dashboard;
  if (flags.noVerifier) args.noVerifier = true;
  if (flags.untilStop) args.untilStop = true;
  return args;
}

function parsePlan(rest: string, leading: LaunchFlags): HordeArgs {
  const afterPlan = takeLaunchFlags(rest);
  if (afterPlan.error) return { kind: "usage", error: afterPlan.error };
  const parsed = parseCountedRun(afterPlan.rest, mergeLaunchFlags(leading, afterPlan));
  if ("error" in parsed) {
    return { kind: "usage", error: "plan usage: /agent-horde plan <count> <layer1; layer2; ...>" };
  }
  const layers = parsed.rest
    .split(/[;\n]/)
    .map((layer) => layer.trim())
    .filter(Boolean);
  if (layers.length < 2) {
    return { kind: "usage", error: "plan needs at least 2 layers separated by ';'" };
  }
  if (layers.length < parsed.hordes) {
    return { kind: "usage", error: `plan with ${parsed.hordes} hordes needs at least ${parsed.hordes} layers` };
  }
  return runArgs(parsed, layers.join("; "), layers);
}

export function parseHordeArgs(raw: string): HordeArgs {
  const leading = takeLaunchFlags(raw);
  if (leading.error) return { kind: "usage", error: leading.error };
  const trimmed = leading.rest;
  const hasFlags = leading.dashboard !== undefined || leading.noVerifier === true || leading.untilStop === true;
  if (trimmed === "") {
    return hasFlags ? { kind: "usage", error: "count is required" } : { kind: "usage" };
  }

  const space = trimmed.search(/\s/);
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : trimmed.slice(space + 1);
  if (hasFlags && head !== "plan" && !/^\d+(?:\/\d+)?$/.test(head)) {
    return { kind: "usage", error: "launch flags only apply when starting a run" };
  }

  switch (head) {
    case "help":
      return { kind: "help" };
    case "status": {
      const target = parseTargets(rest);
      return target ? { kind: "status", target } : { kind: "usage", error: TARGET_ERROR };
    }
    case "stop":
    case "stop-hard":
    case "stop-clean": {
      const mode: HordeStopMode = head === "stop-clean" ? "clean" : "hard";
      const parsed = parseStopRest(rest, mode);
      if ("error" in parsed) return { kind: "usage", error: parsed.error };
      return {
        kind: "stop",
        mode,
        target: parsed.target,
        postmortem: parsed.postmortem,
        graceMs: parsed.graceMs,
      };
    }
    case "pause": {
      const target = parseTargets(rest);
      return target ? { kind: "pause", target } : { kind: "usage", error: TARGET_ERROR };
    }
    case "plan":
      return parsePlan(rest, leading);
    case "resume": {
      const target = parseTargets(rest);
      return target ? { kind: "resume", target } : { kind: "usage", error: TARGET_ERROR };
    }
  }

  const parsed = parseCountedRun(trimmed, leading);
  if ("error" in parsed) return { kind: "usage", error: parsed.error };
  if (parsed.rest === "") return { kind: "usage", error: "prompt is required" };
  return runArgs(parsed, parsed.rest);
}
