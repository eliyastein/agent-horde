import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatElapsed, formatTokens } from "../format.js";
import { statusCounts } from "../prompt.js";
import { HordeWidget } from "../widget.js";
import type { HordeRun, ReportDetails } from "./types.js";

const WIDGET_KEY = "agent-horde";

export const REPORT_TYPE = "agent-horde-report";

const RENDER_INTERVAL_MS = 100;

export function registerReportRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<ReportDetails>(REPORT_TYPE, (message, { outputPad }, theme) => {
    const d = message.details;
    if (!d) return undefined;
    const counts = statusCounts(d.members);
    const verb = d.stopped ? "stopped" : "finished";
    const title = `horde ${d.runId} ${verb}: ${counts.done} done, ${counts.failed} failed, ` +
      `${counts.stopped} stopped, ${formatElapsed(d.elapsedMs)}`;
    const lines = [theme.bold(theme.fg("accent", title))];
    for (const m of d.members) {
      const detail = m.error ? `  ${m.error}` : "";
      lines.push(theme.fg("muted", `  ${m.name.padEnd(9)} ${m.status.padEnd(8)} t${m.turns}  ` +
        `${formatTokens(m.tokens)} tok${detail}`));
    }
    if (d.diagnosis) lines.push("", theme.fg("muted", d.diagnosis));
    if (d.deliverable) {
      lines.push("", theme.bold(theme.fg("accent", `horde ${d.runId} deliverable`)), "");
      lines.push(d.deliverable.trimEnd());
    }
    if (d.postmortem) {
      lines.push("", theme.bold(theme.fg("accent", `horde ${d.runId} post-mortem`)), "");
      lines.push(d.postmortem.trimEnd());
    }
    return new Text(lines.join("\n"), outputPad, 0);
  });
}

/** Which run owns the widget on a shared UI context; a later run must not be clobbered. */
const widgetOwners = new WeakMap<ExtensionUIContext, HordeRun>();

export function refreshRun(run: HordeRun): void {
  if (!run.ui || widgetOwners.get(run.ui) !== run) return;
  if (run.finalizing && run.finalizing.length > 0) {
    run.ui.setStatus(WIDGET_KEY, `horde ${run.id} synthesizing: ${run.finalizing.join(", ")}`);
    run.tui?.requestRender();
    return;
  }
  const c = statusCounts(run.members);
  const paused = run.members.filter((m) => m.paused).length;
  let text = `horde ${c.running + c.starting}/${run.count} running`;
  if (paused > 0) text += `, ${paused} paused`;
  if (run.cleanStopUntil !== undefined) {
    const left = Math.max(0, Math.ceil((run.cleanStopUntil - Date.now()) / 1000));
    text += `, clean stop in ${left}s`;
  }
  run.ui.setStatus(WIDGET_KEY, text);
  run.tui?.requestRender();
}

export function mountWidget(run: HordeRun, ui: ExtensionUIContext): void {
  run.ui = ui;
  widgetOwners.set(ui, run);
  ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      run.tui = tui;
      return new HordeWidget(run, theme);
    },
    { placement: "aboveEditor" },
  );
  run.timer = setInterval(() => refreshRun(run), RENDER_INTERVAL_MS);
  run.timer.unref();
}

export function unmountWidget(run: HordeRun): void {
  if (run.timer) clearInterval(run.timer);
  run.timer = undefined;
  if (!run.ui || widgetOwners.get(run.ui) !== run) return;
  widgetOwners.delete(run.ui);
  run.ui.setWidget(WIDGET_KEY, undefined);
  run.ui.setStatus(WIDGET_KEY, undefined);
}

export function reportDetails(run: HordeRun, now: number): ReportDetails {
  return {
    runId: run.id,
    elapsedMs: now - run.startedAt,
    stopped: run.stopped,
    diagnosis: run.diagnosis,
    postmortem: run.postmortem,
    deliverable: run.deliverable,
    members: run.members.map((m) => ({
      name: m.name,
      status: m.status,
      turns: m.turns,
      error: m.error,
      tokens: m.usage.input + m.usage.output,
    })),
  };
}

export function safeNotifyUi(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // The extension instance can be torn down after session_shutdown.
  }
}

export function safeNotify(run: HordeRun, message: string, level: "info" | "warning" | "error"): void {
  try {
    run.ui?.notify(message, level);
  } catch {
    // The extension instance can be torn down after session_shutdown.
  }
}
