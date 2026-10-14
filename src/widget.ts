import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatElapsed } from "./format.js";
import type { MemberState } from "./member.js";
import { memberActivity, statusCounts } from "./prompt.js";

interface WidgetRun {
  id: string;
  members: MemberState[];
  startedAt: number;
  cleanStopUntil?: number | undefined;
  dashboardUrl?: string | undefined;
  /** Steps still running after members finished, e.g. ["deliverable", "post-mortem"]. */
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

export function widgetLines(run: WidgetRun, now: number, width: number, theme: Theme): string[] {
  const frame = Math.floor(now / 100) % SPINNER.length;
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
  return lines.map((line) => truncateToWidth(line, width));
}

export class HordeWidget {
  private readonly run: WidgetRun;
  private readonly theme: Theme;
  private readonly now: () => number;

  constructor(run: WidgetRun, theme: Theme, now: () => number = Date.now) {
    this.run = run;
    this.theme = theme;
    this.now = now;
  }

  render(width: number): string[] {
    return widgetLines(this.run, this.now(), width, this.theme);
  }

  invalidate(): void {}
}
