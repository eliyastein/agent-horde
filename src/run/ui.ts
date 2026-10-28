import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatElapsed, formatTokens } from "../format.js";
import { statusCounts } from "../prompt.js";
import { HordeWidget } from "../widget.js";
import { SWARM_REPORT_TYPE } from "./swarm-report.js";
import type { SwarmReportDetails } from "./swarm-report.js";
import { hordeLabel } from "./types.js";
import type { HordeRun, ReportDetails, Swarm } from "./types.js";

const WIDGET_KEY = "agent-horde";

export const REPORT_TYPE = "agent-horde-report";

const RENDER_INTERVAL_MS = 100;

function registerSwarmReportRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<SwarmReportDetails>(SWARM_REPORT_TYPE, (message, { outputPad }, theme) => {
    const d = message.details;
    if (!d) return undefined;
    const title = `swarm ${d.swarmId} finished: ${d.hordes.length} hordes, ${formatElapsed(d.elapsedMs)}`;
    const lines = [theme.bold(theme.fg("accent", title))];
    for (const h of d.hordes) {
      lines.push(theme.fg("muted", `  ${h.label.padEnd(3)} ${h.outcome.padEnd(18)} ${h.done} done ${h.failed} failed ` +
        `${h.stopped} stopped  t${h.turns}  ${formatTokens(h.tokens)} tok  $${h.cost.toFixed(2)}  ${h.findings} findings`));
    }
    if (d.deliverable) {
      lines.push("", theme.bold(theme.fg("accent", `swarm ${d.swarmId} deliverable`)), "");
      lines.push(d.deliverable.trimEnd());
    }
    return new Text(lines.join("\n"), outputPad, 0);
  });
}

export function registerReportRenderer(pi: ExtensionAPI): void {
  registerSwarmReportRenderer(pi);
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

/** Which swarm owns the widget on a shared UI context; a later swarm must not be clobbered. */
const widgetOwners = new WeakMap<ExtensionUIContext, Swarm>();

/** The swarm each live run belongs to, so a per-run refresh redraws the whole widget. */
const swarmOf = new WeakMap<HordeRun, Swarm>();

/** One run's share of the status line: `h2 11/12 running, 1 paused, clean stop in 40s`. */
function runStatus(run: HordeRun, labelled: boolean): string {
  const c = statusCounts(run.members);
  const paused = run.members.filter((m) => m.paused).length;
  let text = `${labelled ? `${hordeLabel(run.horde)} ` : ""}${c.running + c.starting}/${run.count} running`;
  if (paused > 0) text += `, ${paused} paused`;
  if (run.cleanStopUntil !== undefined) {
    const left = Math.max(0, Math.ceil((run.cleanStopUntil - Date.now()) / 1000));
    text += `, clean stop in ${left}s`;
  }
  if (run.finalizing && run.finalizing.length > 0) text += `, synthesizing ${run.finalizing.join(", ")}`;
  return text;
}

export function refreshSwarm(swarm: Swarm): void {
  if (!swarm.ui || widgetOwners.get(swarm.ui) !== swarm) return;
  const single = swarm.runs.length === 1;
  let text: string;
  if (swarm.finalizing && swarm.finalizing.length > 0) {
    text = `swarm ${swarm.id} synthesizing: ${swarm.finalizing.join(", ")}`;
  } else if (single && swarm.runs[0]!.finalizing && swarm.runs[0]!.finalizing.length > 0) {
    text = `horde ${swarm.id} synthesizing: ${swarm.runs[0]!.finalizing.join(", ")}`;
  } else {
    const parts = swarm.runs.map((run) => runStatus(run, !single));
    text = single ? `horde ${parts[0]}` : `swarm ${parts.join("; ")}`;
  }
  swarm.ui.setStatus(WIDGET_KEY, text);
  swarm.tui?.requestRender();
}

export function refreshRun(run: HordeRun): void {
  const swarm = swarmOf.get(run);
  if (swarm) refreshSwarm(swarm);
}

export function mountWidget(swarm: Swarm, ui: ExtensionUIContext): void {
  swarm.ui = ui;
  for (const run of swarm.runs) {
    run.ui = ui;
    swarmOf.set(run, swarm);
  }
  widgetOwners.set(ui, swarm);
  ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      swarm.tui = tui;
      return new HordeWidget(swarm, theme);
    },
    { placement: "aboveEditor" },
  );
  swarm.timer = setInterval(() => refreshSwarm(swarm), RENDER_INTERVAL_MS);
  swarm.timer.unref();
}

export function unmountWidget(swarm: Swarm): void {
  if (swarm.timer) clearInterval(swarm.timer);
  swarm.timer = undefined;
  if (!swarm.ui || widgetOwners.get(swarm.ui) !== swarm) return;
  widgetOwners.delete(swarm.ui);
  swarm.ui.setWidget(WIDGET_KEY, undefined);
  swarm.ui.setStatus(WIDGET_KEY, undefined);
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

export function safeNotify(run: Pick<HordeRun, "ui">, message: string, level: "info" | "warning" | "error"): void {
  try {
    run.ui?.notify(message, level);
  } catch {
    // The extension instance can be torn down after session_shutdown.
  }
}
