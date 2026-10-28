import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { hordeLabel } from "./types.js";
import type { Swarm } from "./types.js";

const CONTROL_SUBCOMMANDS: Array<{
  value: string;
  description: string;
  takesTarget: boolean;
}> = [
  { value: "status", description: "show per-member status", takesTarget: true },
  { value: "stop-hard", description: "terminate members now (SIGTERM, then SIGKILL)", takesTarget: true },
  { value: "stop-clean", description: "let members wrap up and reconcile ideas; add 'postmortem' for a run review", takesTarget: true },
  { value: "pause", description: "suspend members (SIGSTOP)", takesTarget: true },
  { value: "resume", description: "resume suspended members (SIGCONT)", takesTarget: true },
  { value: "plan", description: "partition members across workstreams: plan <count> <a; b; ...>", takesTarget: false },
  { value: "help", description: "show usage", takesTarget: false },
];

const DASHBOARD_COMPLETION = {
  value: "--dashboard ",
  description: "serve a read-only localhost dashboard (port 7433, or --dashboard=<port>)",
};

const NO_VERIFIER_COMPLETION = {
  value: "--no-verifier ",
  description: "do not assign the verifier role to the last member of a 3+ member run",
};

const UNTIL_STOP_COMPLETION = {
  value: "--until-stop ",
  description: "keep the whole horde working until stop-clean or stop-hard; validated solves are banked",
};

const LAUNCH_FLAG_COMPLETIONS = [DASHBOARD_COMPLETION, NO_VERIFIER_COMPLETION, UNTIL_STOP_COMPLETION];

/** Argument completions that are not member targets. */
const EXTRA_COMPLETIONS: Record<string, Array<{ value: string; description: string }>> = {
  "stop-clean": [
    { value: "postmortem ", description: "also run a post-mortem review of the run" },
    { value: "--grace=60", description: "seconds before hard stop (default 90); edit the number" },
  ],
  plan: [DASHBOARD_COMPLETION],
};

/** `all`, then the members of a single horde, or `hN` and `hN:member-M` for a larger swarm. */
function targetNames(active: Swarm | undefined): Array<{ name: string; description: string }> {
  if (!active) return [{ name: "all", description: "all members" }];
  const total = active.runs.reduce((sum, run) => sum + run.members.length, 0);
  const names = [{ name: "all", description: active.hordes > 1 ? `all ${total} members of ${active.hordes} hordes` : `all ${total} members` }];
  if (active.hordes === 1) {
    for (const member of active.runs[0]?.members ?? []) names.push({ name: member.name, description: member.status });
    return names;
  }
  for (const run of active.runs) {
    const label = hordeLabel(run.horde);
    names.push({ name: label, description: `horde ${label}: ${run.members.length} members` });
    for (const member of run.members) names.push({ name: `${label}:${member.name}`, description: member.status });
  }
  return names;
}

export function controlCompletions(prefix: string, active: Swarm | undefined): AutocompleteItem[] | null {
  const space = prefix.search(/\s/);
  if (space === -1 && prefix.startsWith("-")) {
    const items = LAUNCH_FLAG_COMPLETIONS.filter((flag) => flag.value.startsWith(prefix)).map(
      (flag) => ({ ...flag, label: flag.value.trim() }),
    );
    return items.length > 0 ? items : null;
  }
  if (space === -1) {
    const items = CONTROL_SUBCOMMANDS.filter((sub) =>
      sub.value.startsWith(prefix.toLowerCase()),
    ).map((sub) => ({
      value: sub.value === "help" ? "help" : `${sub.value} `,
      label: sub.value,
      description: sub.description,
    }));
    return items.length > 0 ? items : null;
  }
  const head = prefix.slice(0, space).toLowerCase();
  const sub = CONTROL_SUBCOMMANDS.find((candidate) => candidate.value === head);
  if (!sub) return null;
  const rest = prefix.slice(space + 1);
  const match = /^([\s\S]*?)([^\s,]*)$/.exec(rest);
  const base = match?.[1] ?? "";
  const token = match?.[2] ?? "";
  const targetItems: AutocompleteItem[] = (sub.takesTarget ? targetNames(active) : [])
    .filter((target) => target.name.startsWith(token))
    .map((target) => ({
      value: `${head} ${base}${target.name}`,
      label: target.name,
      description: target.description,
    }));
  const extraItems: AutocompleteItem[] = (EXTRA_COMPLETIONS[head] ?? [])
    .filter((extra) => {
      const literal = extra.value.trim();
      const flag = literal.split("=")[0] ?? literal;
      return !base.includes(flag) && literal.startsWith(token);
    })
    .map((extra) => ({
      value: `${head} ${base}${extra.value}`,
      label: extra.value.trim(),
      description: extra.description,
    }));
  const items = [...extraItems, ...targetItems];
  return items.length > 0 ? items : null;
}
