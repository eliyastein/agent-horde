import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatElapsed, formatTokens } from "./format.js";
import type { MemberState } from "./member.js";
import { memberActivity, statusCounts, totalUsage } from "./prompt.js";

interface WidgetRun {
  id: string;
  horde: number;
  members: MemberState[];
  startedAt: number;
  cleanStopUntil?: number | undefined;
  dashboardUrl?: string | undefined;
  /** Steps still running after members finished, e.g. ["deliverable", "post-mortem"]. */
  finalizing?: string[] | undefined;
  reported?: boolean | undefined;
  finalized?: boolean | undefined;
  outcome?: string | undefined;
}

interface WidgetSwarm {
  id: string;
  runs: WidgetRun[];
  startedAt: number;
  dashboardUrl?: string | undefined;
  /** The swarm step still running after every horde finalized, e.g. ["merge"]. */
  finalizing?: string[] | undefined;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COLLAPSE_ABOVE = 8;

function statusGlyph(m: MemberState, frame: number, theme: Theme): string {
  if (m.paused) return theme.fg("warning", "⏸");
  switch (m.status) {
    case "starting":
      return theme.fg("dim", "·");
    case "running":
      return theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "⠋");
    case "done":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "stopped":
      return theme.fg("warning", "■");
  }
}

export function headerLine(run: WidgetRun, now: number, theme: Theme): string {
  const c = statusCounts(run.members);
  const parts = [
    theme.bold(theme.fg("accent", `horde ${run.id}`)),
    `${c.running + c.starting} running`,
    `${c.done} done`,
  ];
  if (c.failed) parts.push(theme.fg("error", `${c.failed} failed`));
  if (c.stopped) parts.push(theme.fg("warning", `${c.stopped} stopped`));
  parts.push(formatElapsed(now - run.startedAt));
  if (run.cleanStopUntil !== undefined) {
    const left = Math.max(0, Math.ceil((run.cleanStopUntil - now) / 1000));
    parts.push(theme.fg("warning", `clean stop in ${left}s`));
  }
  if (run.finalizing && run.finalizing.length > 0) {
    parts.push(theme.fg("warning", `synthesizing ${run.finalizing.join(", ")}`));
  }
  if (run.dashboardUrl) parts.push(`${run.dashboardUrl}runs/${run.id}`);
  return `${parts.join("  ")}  ${theme.fg("dim", "/agent-horde status | stop-hard | stop-clean")}`;
}

function memberLine(m: MemberState, now: number, frame: number, theme: Theme): string {
  const elapsed = formatElapsed((m.endedAt ?? now) - m.startedAt);
  const activity = memberActivity(m);
  const activityColor = m.status === "failed" ? "error" : "muted";
  const resets = m.resets ? `  r${m.resets}` : "";
  return (
    ` ${statusGlyph(m, frame, theme)} ${m.name.padEnd(9)} ${theme.fg("dim", m.status.padEnd(8))} ` +
    `${theme.fg(activityColor, activity)}  ${theme.fg("dim", `${elapsed}  t${m.turns}${resets}`)}`
  );
}

/** The widget for one horde: a header, then a line per member (a glyph strip past eight). */
function runLines(run: WidgetRun, now: number, frame: number, theme: Theme): string[] {
  const lines = [headerLine(run, now, theme)];
  if (run.members.length > COLLAPSE_ABOVE) {
    lines.push(` ${run.members.map((m) => statusGlyph(m, frame, theme)).join(" ")}`);
    const failed = run.members.filter((m) => m.status === "failed");
    if (failed.length) {
      lines.push(theme.fg("error", ` failed: ${failed.map((m) => m.name).join(", ")}`));
    }
  } else {
    for (const m of run.members) lines.push(memberLine(m, now, frame, theme));
  }
  return lines;
}

/** What one horde of a swarm is doing, in a word. */
function hordeActivity(run: WidgetRun, c: ReturnType<typeof statusCounts>): string {
  if (run.finalized) return run.outcome ?? "finished";
  if (run.finalizing && run.finalizing.length > 0) return `synthesizing ${run.finalizing.join(", ")}`;
  if (run.reported) return "finalizing";
  if (run.cleanStopUntil !== undefined) return "stopping";
  return c.running + c.starting > 0 ? "running" : "finishing";
}

/** One line per horde: `h2  11/12 running  1 done  t120  45.2k tok  $1.20  running`. */
export function hordeLine(run: WidgetRun, now: number, frame: number, theme: Theme): string {
  const c = statusCounts(run.members);
  const usage = totalUsage(run.members);
  const live = run.members.find((m) => m.status === "running");
  const glyph = run.finalized
    ? theme.fg("success", "✓")
    : live
      ? theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "⠋")
      : theme.fg("dim", "·");
  const parts = [
    `${c.running + c.starting}/${run.members.length} running`,
    `${c.done} done`,
  ];
  if (c.failed) parts.push(theme.fg("error", `${c.failed} failed`));
  if (c.stopped) parts.push(theme.fg("warning", `${c.stopped} stopped`));
  parts.push(theme.fg("dim", `t${usage.turns}  ${formatTokens(usage.input + usage.output)} tok  $${usage.cost.toFixed(2)}`));
  parts.push(theme.fg("muted", hordeActivity(run, c)));
  return ` ${glyph} ${`h${run.horde}`.padEnd(3)} ${parts.join("  ")}`;
}

function swarmHeader(swarm: WidgetSwarm, now: number, theme: Theme): string {
  const members = swarm.runs.flatMap((run) => run.members);
  const c = statusCounts(members);
  const parts = [
    theme.bold(theme.fg("accent", `swarm ${swarm.id}`)),
    `${swarm.runs.length} hordes`,
    `${c.running + c.starting} running`,
    `${c.done} done`,
  ];
  if (c.failed) parts.push(theme.fg("error", `${c.failed} failed`));
  if (c.stopped) parts.push(theme.fg("warning", `${c.stopped} stopped`));
  parts.push(formatElapsed(now - swarm.startedAt));
  if (swarm.finalizing && swarm.finalizing.length > 0) {
    parts.push(theme.fg("warning", `synthesizing ${swarm.finalizing.join(", ")}`));
  }
  if (swarm.dashboardUrl) parts.push(`${swarm.dashboardUrl}swarms/${swarm.id}`);
  return `${parts.join("  ")}  ${theme.fg("dim", "/agent-horde status | stop-hard | stop-clean [hN]")}`;
}

/** A swarm of one shows its run as before; a larger swarm shows one line per horde. */
export function widgetLines(swarm: WidgetSwarm, now: number, width: number, theme: Theme): string[] {
  const frame = Math.floor(now / 100) % SPINNER.length;
  const single = swarm.runs.length === 1 ? swarm.runs[0] : undefined;
  const lines = single
    ? runLines(single, now, frame, theme)
    : [swarmHeader(swarm, now, theme), ...swarm.runs.map((run) => hordeLine(run, now, frame, theme))];
  return lines.map((line) => truncateToWidth(line, width));
}

export class HordeWidget {
  private readonly swarm: WidgetSwarm;
  private readonly theme: Theme;
  private readonly now: () => number;

  constructor(swarm: WidgetSwarm, theme: Theme, now: () => number = Date.now) {
    this.swarm = swarm;
    this.theme = theme;
    this.now = now;
  }

  render(width: number): string[] {
    return widgetLines(this.swarm, this.now(), width, this.theme);
  }

  invalidate(): void {}
}
