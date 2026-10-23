export const MAX_MEMBERS = 12;

export const USAGE = [
  "usage: /agent-horde [--dashboard[=<port>]] [--no-verifier] [--until-stop] <count> <prompt>",
  "                                          spawn <count> members with the same prompt",
  "       /agent-horde status [target]       show the active run",
  "       /agent-horde stop-hard [target]    terminate members now (SIGTERM, then SIGKILL)",
  "       /agent-horde stop-clean [target]   let members wrap up, then reconcile their ideas",
  "       /agent-horde stop-clean postmortem [target] [--grace <s>]",
  "                                          additionally run a post-mortem on the run",
  "       /agent-horde pause [target]        suspend members (SIGSTOP)",
  "       /agent-horde resume [target]       resume suspended members (SIGCONT)",
  `       /agent-horde plan [--dashboard] <count> <a; b; ...>`,
  "                                          partition members across workstreams",
  "       /agent-horde help                  show this text",
  "",
  "target is 'all' (default), 'member-N', 'N', or a comma/space separated list.",
  `count is a whole number from 1 to ${MAX_MEMBERS}`,
  "--dashboard serves a read-only localhost dashboard (default port 7433, or",
  "PI_HORDE_DASHBOARD_PORT); --dashboard=<port> picks the port.",
  "--no-verifier skips the default verifier role that runs of 3 or more members assign",
  "to their last member.",
  "--until-stop keeps the whole horde working until you run stop-clean or stop-hard: a",
  "validated solve is banked as the current answer and a member that finishes gets a fresh",
  "session told to add new ideas.",
].join("\n");

/** Which members a control command applies to. */
export type HordeTarget =
  | { kind: "all" }
  | { kind: "members"; names: string[] };

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

function parseTargets(raw: string): HordeTarget | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "all" };
  const names: string[] = [];
  for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
    if (token.toLowerCase() === "all") return { kind: "all" };
    const match = /^(?:member-)?(\d+)$/i.exec(token);
    if (!match) return undefined;
    const index = Number(match[1]);
    if (index < 1 || index > MAX_MEMBERS) return undefined;
    names.push(`member-${index}`);
  }
  return names.length > 0 ? { kind: "members", names } : { kind: "all" };
}

const TARGET_ERROR = "invalid target; use all, member-N, or N";

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

/** Parse `<count> [flags] <tail>`. */
function parseCountedRun(
  text: string,
  leading: LaunchFlags,
): { count: number; rest: string; flags: LaunchFlags } | { error: string } {
  const match = /^(\d+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return { error: `count must be a whole number from 1 to ${MAX_MEMBERS}` };
  const count = Number(match[1]);
  if (count < 1 || count > MAX_MEMBERS) {
    return { error: `count must be a whole number from 1 to ${MAX_MEMBERS}` };
  }
  const flags = mergeLaunchFlags(leading, takeLaunchFlags(match[2] ?? ""));
  if (flags.error) return { error: flags.error };
  return { count, rest: flags.rest, flags };
}

function runArgs(count: number, prompt: string, flags: LaunchFlags, plan?: string[]): HordeRunArgs {
  const args: HordeRunArgs = { kind: "run", count, prompt };
  if (plan) args.plan = plan;
  if (flags.dashboard) args.dashboard = flags.dashboard;
  if (flags.noVerifier) args.noVerifier = true;
  if (flags.untilStop) args.untilStop = true;
  return args;
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
  if (hasFlags && head !== "plan" && !/^\d+$/.test(head)) {
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
    case "plan": {
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
      return runArgs(parsed.count, layers.join("; "), parsed.flags, layers);
    }
    case "resume": {
      const target = parseTargets(rest);
      return target ? { kind: "resume", target } : { kind: "usage", error: TARGET_ERROR };
    }
  }

  const parsed = parseCountedRun(trimmed, leading);
  if ("error" in parsed) return { kind: "usage", error: parsed.error };
  if (parsed.rest === "") return { kind: "usage", error: "prompt is required" };
  return runArgs(parsed.count, parsed.rest, parsed.flags);
}
