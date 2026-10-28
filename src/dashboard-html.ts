import type { BoardEntry } from "./ledger/board.js";
import type { ClaimEntry } from "./ledger/claims.js";
import type { FactEntry } from "./ledger/facts.js";
import type { FindingEntry } from "./ledger/findings.js";
import type { Idea } from "./ledger/ideas.js";
import type { PeerMessage } from "./ledger/collaboration.js";
import type {
  BoardVm,
  CollaborationVm,
  ClaimsVm,
  FactsVm,
  FileVm,
  FindingsVm,
  IdeasVm,
  MemberDetailVm,
  MemberLogVm,
  MemberRowVm,
  ResourcesVm,
  RunGraphVm,
  RunIndexVm,
  RunOverviewVm,
  SessionsVm,
  SwarmGraphVm,
  SwarmHorde,
  SwarmLedgerVm,
  SwarmVm,
  TranscriptEntryVm,
  TranscriptVm,
} from "./dashboard-data.js";
import { RUN_FILES, SWARM_FILES } from "./dashboard-data.js";
import { buildInfo } from "./build-info.js";
import { detailKey, formatClock, formatElapsed, formatTokens, oneLine } from "./format.js";
import { renderRunGraphMermaid } from "./run-graph-mermaid.js";
import { GRAPH_CSS, graphLegendHtml, renderRunGraphSvg } from "./run-graph-svg.js";
import type { TranscriptEntry, TranscriptPart } from "./session-log.js";

/**
 * What a page is about, fixed by its URL: the ledgers single runs share (`/`, `/findings`), one run
 * (`/runs/<id>/...`), or a whole swarm (`/swarms/<id>/...`). A horde of a swarm is a run scope that
 * also knows its swarm, so the nav can offer the sibling hordes. Every scoped link derives from this.
 */
export type Scope =
  | { kind: "project" }
  | { kind: "run"; runId: string; swarm?: { id: string; hordes: SwarmHorde[] } | undefined }
  | { kind: "swarm"; swarmId: string; hordes: SwarmHorde[] };

/** The page types every scope offers in the page row; `other` is a run-only page such as a transcript. */
export type PageKind =
  | "overview" | "ideas" | "board" | "findings" | "claims" | "facts" | "resources" | "collaboration" | "graph" | "other";

/** Per-request facts the renderers need beyond the view model. */
export interface RenderContext {
  href?: string;
  scope?: Scope | undefined;
  pageKind?: PageKind | undefined;
  /**
   * A swarm in memory, set on project pages only: its hordes write their own ledgers, so the
   * project page points at the same page in the swarm. `finishing` once no horde is running.
   */
  liveSwarm?: { id: string; finishing: boolean } | undefined;
  refresh?: { on: boolean; toggleHref: string; seconds: number } | undefined;
  /** Scheme and host of the request, for exports that need absolute links. */
  origin?: string | undefined;
  /** Rendering for the static export: no refresh, no export control, native disclosure. */
  export?: boolean | undefined;
}

interface Crumb {
  text: string;
  href?: string | undefined;
}

const CSS =
  "body{font:13px/1.35 ui-monospace,Menlo,monospace;color:#000;background:#fff;margin:8px}" +
  "table{border-collapse:collapse;margin:4px 0}" +
  "th,td{border:1px solid #000;padding:2px 6px;vertical-align:top;text-align:left}" +
  "th{background:#eee}pre{white-space:pre-wrap;word-break:break-word;margin:0}" +
  "nav{margin:2px 0}nav a,nav b{margin-right:8px}.scope{margin:2px 0}.scope a,.scope b{margin-right:6px}.pointer{border:1px solid #000;padding:2px 6px;display:inline-block}.r{text-align:right}h1,h2{font-size:13px;margin:8px 0 4px}" +
  "details>summary{cursor:pointer}a{color:#000}footer{margin-top:16px;color:#666}footer a{color:#666}" +
  ".export{position:absolute;top:8px;right:8px;line-height:0}" +
  ".modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7)}" +
  ".modal:target{display:flex;align-items:center;justify-content:center}" +
  ".modal-box{background:#fff;border:3px solid #000;padding:32px;width:min(90vw,760px);font-size:18px;line-height:1.5}" +
  ".modal-box h2{font-size:24px;margin:0 0 16px}" +
  ".modal-box .btn{display:inline-block;border:2px solid #000;padding:8px 16px;margin-right:12px}" +
  GRAPH_CSS;

const EXPORT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
  '<path d="M12 3v12m0 0l-5-5m5 5l5-5M4 17v3h16v-3" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

const EXPORT_WARNING =
  "The zip holds every page of this dashboard as static HTML: every run, every member transcript and log, " +
  "the run documents, the shared ledgers and the event audit. Transcripts include everything members read " +
  "and produced on this machine: file contents, command output, paths, and any secrets or credentials they " +
  "encountered. Review the export before sharing it with anyone who should not see all of that.";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const e = escapeHtml;

export function link(href: string, text: string): string {
  return `<a href="${e(href)}">${e(text)}</a>`;
}

/** A bordered table; cells are already HTML. */
export function table(headers: string[], rows: string[][], empty = "none"): string {
  if (rows.length === 0) return `<p>${e(empty)}</p>`;
  const head = `<tr>${headers.map((h) => `<th>${e(h)}</th>`).join("")}</tr>`;
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<table>${head}${body}</table>`;
}

export function pre(text: string): string {
  return `<pre>${e(text)}</pre>`;
}

export function details(summary: string, body: string, identity?: string): string {
  const key = detailKey(identity ?? `${summary}\0${body}`);
  return `<details data-expand="${key}"><summary>${e(summary)}</summary>${body}</details>`;
}

function grid(rows: Array<[string, string]>): string {
  return `<table>${rows.map(([k, v]) => `<tr><th>${e(k)}</th><td>${v}</td></tr>`).join("")}</table>`;
}

function query(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function runHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

function memberHref(runId: string, member: string): string {
  return `${runHref(runId)}/members/${encodeURIComponent(member)}`;
}

function swarmHref(swarmId: string): string {
  return `/swarms/${encodeURIComponent(swarmId)}`;
}

/** The path every scoped link starts from: `` for the project, `/runs/<id>`, or `/swarms/<id>`. */
function scopeBase(scope: Scope | undefined): string {
  if (scope?.kind === "run") return runHref(scope.runId);
  if (scope?.kind === "swarm") return swarmHref(scope.swarmId);
  return "";
}

/** The run a page's member names link into; none in the project or swarm scope. */
function scopeRunId(ctx: RenderContext): string | undefined {
  return ctx.scope?.kind === "run" ? ctx.scope.runId : undefined;
}

const LEDGER_PAGES = ["ideas", "board", "findings", "claims", "facts", "resources"] as const;

/** The project scope has its ledgers only; a run or swarm also has an overview, collaboration and graph. */
function pagesOf(scope: Scope | undefined): PageKind[] {
  return scope === undefined || scope.kind === "project"
    ? [...LEDGER_PAGES]
    : ["overview", ...LEDGER_PAGES, "collaboration", "graph"];
}

/** The same page type under another base; pages a scope does not share fall back to its overview. */
function pageHref(base: string, kind: PageKind | undefined): string {
  if (kind === undefined || kind === "overview" || kind === "other") return base || "/";
  return `${base}/${kind}`;
}

/** The current item is shown, not linked. */
function navItem(href: string, text: string, current: boolean): string {
  return current ? `<b>${e(text)}</b>` : link(href, text);
}

/** `all | h1 | h2 ...` for a swarm or one of its hordes; each tab keeps the page type. */
function hordeTabs(swarmId: string, hordes: SwarmHorde[], current: string | undefined, kind: PageKind | undefined): string {
  const tabs = [
    navItem(pageHref(swarmHref(swarmId), kind), "all", current === undefined),
    ...hordes.map((horde) => navItem(pageHref(runHref(horde.runId), kind), horde.label, horde.runId === current)),
  ];
  return ` hordes: ${tabs.join(" ")}`;
}

/** On a project page while a swarm is live: where the swarm's activity is, on the same page type. */
function swarmPointer(ctx: RenderContext): string {
  const swarm = ctx.liveSwarm;
  if (!swarm) return "";
  const target = ctx.pageKind === undefined || ctx.pageKind === "overview" || ctx.pageKind === "other"
    ? "the swarm"
    : `the swarm's ${ctx.pageKind}`;
  return (
    `<p class="pointer">swarm ${e(swarm.id)} is ${swarm.finishing ? "finishing" : "running"} in its own ledgers, ` +
    `not these: ${link(pageHref(swarmHref(swarm.id), ctx.pageKind), target)}</p>`
  );
}

/** The scope line: what this page is about, and inside a swarm the tabs to move between hordes. */
function scopeLine(ctx: RenderContext): string {
  const scope = ctx.scope;
  if (scope === undefined || scope.kind === "project") {
    return `<p class="scope">scope: <b>project</b></p>${swarmPointer(ctx)}`;
  }
  if (scope.kind === "swarm") {
    return `<p class="scope">scope: <b>swarm ${e(scope.swarmId)}</b>${hordeTabs(scope.swarmId, scope.hordes, undefined, ctx.pageKind)}</p>`;
  }
  if (!scope.swarm) return `<p class="scope">scope: <b>run ${e(scope.runId)}</b></p>`;
  const horde = scope.swarm.hordes.find((h) => h.runId === scope.runId)?.label ?? "horde";
  return (
    `<p class="scope">scope: ${link(swarmHref(scope.swarm.id), `swarm ${scope.swarm.id}`)} &rsaquo; <b>${e(horde)}</b>` +
    `${hordeTabs(scope.swarm.id, scope.swarm.hordes, scope.runId, ctx.pageKind)}</p>`
  );
}

/**
 * Three rows: `runs` to the index, the scope line, and the page row. Every link in the page row is
 * built from the page's own scope, so nothing silently points at some other run.
 */
function nav(ctx: RenderContext): string {
  const base = scopeBase(ctx.scope);
  const pages = pagesOf(ctx.scope).map((kind) => navItem(pageHref(base, kind), kind, kind === ctx.pageKind));
  const onIndex = (ctx.href ?? "").split("?")[0] === "/";
  return `<nav>${navItem("/", "runs", onIndex)}</nav>${scopeLine(ctx)}<nav>${pages.join("")}</nav>`;
}

/** An id cell that deep links, including the run graph, can target. */
function anchor(id: string): string {
  return `<span id="${e(id)}">${e(id)}</span>`;
}

function withEvidence(text: string, evidence: string[] | undefined): string {
  return evidence?.length ? `${text} (evidence ${evidence.join(", ")})` : text;
}

/** The request, the recipient's response and the sender's resolution, each with its own evidence. */
function messageThread(m: PeerMessage): string {
  const lines = [m.text, `Response: ${m.response ? withEvidence(m.response, m.responseEvidence) : "pending"}`];
  if (m.resolution !== undefined) lines.push(`${m.state === "deferred" ? "Deferred" : "Resolution"}: ${withEvidence(m.resolution, m.resolutionEvidence)}`);
  lines.push(`Evidence: ${m.evidence.join(", ") || "none"}`);
  return lines.join("\n");
}

/** Acceptance, requests, artifacts, reviews, resources and metrics; the event audit only on a run's own page. */
function collaborationBody(vm: CollaborationVm, withAudit: boolean): string {
  const { report } = vm;
  const { state } = report;
  const messages = table(["request", "owner", "state / age", "target", "question / response"], state.messages.map((m) => [
    anchor(m.id), e(`${m.sender} -> ${m.to}`), e(`${m.state}${m.blocking ? " BLOCKING" : ""} / ${formatElapsed(Date.now() - Date.parse(m.createdAt))}`),
    e(`${m.target}@${m.revision}`), pre(messageThread(m)),
  ]));
  const reviews = table(["review", "target revision", "verdict", "scope / evidence"], state.reviews.map((r) => [`${anchor(r.id)} @${e(r.actor)}`, e(`${r.target}@${r.revision}`), e(`${r.verdict} [${r.support}]`), pre(`Checked: ${r.checked}\nUnchecked: ${r.unchecked || "none declared"}\nLimits: ${r.limits || "none disclosed"}\nEvidence: ${r.evidence.join(", ")}${r.reattests ? `\nReattests: ${r.reattests}` : ""}\n${r.text}`)]));
  const artifacts = table(["artifact", "hash / dependencies", "acceptance"], state.artifacts.map((a) => [`${anchor(a.id)} ${e(`${a.path} @${a.owner} (${a.kind ?? "runnable"})`)}`, pre(`${a.hash}\n${JSON.stringify(a.dependencies)}`), e(report.acceptedArtifacts.includes(a.id) ? "accepted" : "excluded / needs review")]));
  const summary =
    (vm.historical ? "<p>Historical run: no delivery/revision history was recorded.</p>" : "") +
    `<h2>Acceptance issues</h2>${pre(report.issues.join("\n") || "none recorded")}<h2>Requests</h2>${messages}<h2>Artifacts</h2>${artifacts}<h2>Reviews</h2>${reviews}` +
    `<h2>Resource readiness and leases</h2>${pre(JSON.stringify(state.resources, null, 2))}<h2>Metrics</h2>${pre(JSON.stringify(report.metrics, null, 2))}`;
  if (!withAudit) {
    return `${summary}<p>${link(`${runHref(report.runId)}/collaboration`, "event audit")} on the horde's own page</p>`;
  }
  const events = vm.events.map((event) => `<div id="${e(event.eventId)}">${details(`${event.eventId} ${event.at} ${event.actor}/${event.attempt} ${event.action} ${event.outcome}`, pre(JSON.stringify(event, null, 2)), `event:${report.runId}:${event.eventId}`)}</div>`).join("");
  return `${summary}<h2>Event audit</h2>${events}` +
    (vm.next !== undefined ? link(`${runHref(report.runId)}/collaboration?from=${vm.next}`, "next 100 events") : "");
}

export function renderCollaboration(vm: CollaborationVm, ctx: RenderContext): string {
  const runId = vm.report.runId;
  const crumbs = [{ text: "runs", href: "/" }, { text: runId, href: runHref(runId) }, { text: "collaboration" }];
  return page(`Collaboration ${runId}`, crumbs, collaborationBody(vm, true), ctx);
}

/** Each horde's acceptance, requests and reviews, under per-horde headings. */
export function renderSwarmCollaboration(vm: SwarmLedgerVm<CollaborationVm>, ctx: RenderContext): string {
  return swarmLedgerPage("collaboration", vm, (section) => collaborationBody(section, false), ctx);
}

function crumbLine(crumbs: Crumb[]): string {
  const items = crumbs.map((c, i) => (c.href && i < crumbs.length - 1 ? link(c.href, c.text) : e(c.text)));
  return `<p>${items.join(" / ")}</p>`;
}

function refreshLine(ctx: RenderContext): string {
  if (!ctx.refresh) return "";
  const { on, toggleHref, seconds } = ctx.refresh;
  return on
    ? `<p>auto-refresh: on (${seconds}s) ${link(toggleHref, "[pause]")}</p>`
    : `<p>auto-refresh: off ${link(toggleHref, "[resume]")}</p>`;
}

/** URL-backed disclosure state works across refreshes without scripts or browser storage. */
function persistentDetails(body: string, href = "/"): string {
  const url = new URL(href, "http://localhost");
  const expanded = new Set((url.searchParams.get("expanded") ?? "").split(",").filter((key) => /^[a-f0-9]{20}$/.test(key)).slice(0, 100));
  return body.replace(/<details data-expand="([a-f0-9]+)"><summary>(.*?)<\/summary>([\s\S]*?)<\/details>/g, (_match, key: string, summary: string, content: string) => {
    const next = new URL(url);
    const keys = new Set(expanded);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    if (keys.size) next.searchParams.set("expanded", [...keys].join(","));
    else next.searchParams.delete("expanded");
    next.hash = `detail-${key}`;
    const open = expanded.has(key);
    return `<section id="detail-${key}"><a aria-expanded="${open}" href="${e(next.pathname + next.search + next.hash)}">[${open ? "-" : "+"}] ${summary}</a>${open ? content : ""}</section>`;
  });
}

/** The export opens the modal on the paused page, so a refresh cannot close it; cancel restores the page. */
function exportControl(ctx: RenderContext): string {
  if (ctx.export) return "";
  const current = ctx.href ?? "/";
  const paused = ctx.refresh?.on ? ctx.refresh.toggleHref : current;
  return (
    `<a class="export" href="${e(`${paused}#export`)}" title="export dashboard" aria-label="export dashboard">${EXPORT_ICON}</a>` +
    `<div id="export" class="modal"><div class="modal-box"><h2>Export this dashboard?</h2><p>${EXPORT_WARNING}</p>` +
    `<p><a class="btn" href="${e(`/export${query({ back: current })}`)}">download zip</a><a class="btn" href="${e(current)}">cancel</a></p></div></div>`
  );
}

/** Shown once the download is confirmed; it starts the download itself and says what the wait is. */
export function renderExportStart(zipHref: string, backHref: string, ctx: RenderContext): string {
  const body =
    "<p>The archive is being packed one page at a time and streamed to your browser, so it appears in the " +
    "browser's download list right away and grows until it is complete. A dashboard with long transcripts takes " +
    "a while; the dashboard stays usable meanwhile.</p>" +
    `<p>If no download appears, ${link(zipHref, "download it directly")}.</p>` +
    `<p>${link(backHref, "back to the dashboard")}</p>`;
  const start = `<meta http-equiv="refresh" content="0;url=${e(zipHref)}">`;
  return page("exporting dashboard", [{ text: "runs", href: "/" }, { text: "export" }], body, { ...ctx, refresh: undefined }, start);
}

/** The static export has no server, so disclosure falls back to the browser's own details element. */
function nativeDetails(body: string): string {
  return body.replace(/<details data-expand="[a-f0-9]+">/g, "<details>");
}

/** Which agent-horde produced the page: the package version and, from a checkout, the commit. */
function footer(): string {
  const { name, version, commit, repository } = buildInfo();
  const at = commit ? ` at ${repository ? link(`${repository}/commit/${commit.replace(/-dirty$/, "")}`, commit) : e(commit)}` : "";
  return `<footer>${e(name)} ${e(version)}${at}</footer>`;
}

export function page(title: string, crumbs: Crumb[], body: string, ctx: RenderContext, head = ""): string {
  body = ctx.export ? nativeDetails(body) : persistentDetails(body, ctx.href);
  const meta = ctx.refresh?.on ? `<meta http-equiv="refresh" content="${ctx.refresh.seconds}">` : head;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${e(title)}</title>${meta}` +
    `<style>${CSS}</style></head><body>${exportControl(ctx)}${nav(ctx)}${crumbLine(crumbs)}${refreshLine(ctx)}` +
    `<h1>${e(title)}</h1>${body}${footer()}</body></html>`
  );
}

export function renderError(status: number, message: string, backHref: string, ctx: RenderContext): string {
  const body = `<p>${e(message)}</p><p>${link(backHref, "back")}</p>`;
  return page(`${status}`, [{ text: "runs", href: "/" }, { text: String(status) }], body, { ...ctx, refresh: undefined });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function yn(flag: boolean): string {
  return flag ? "y" : "-";
}

function num(n: number | undefined): string {
  return n === undefined ? "" : String(n);
}

function cost(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** The state column: a live run stands out; pending, finalizing, finished and not started read as written. */
function stateCell(state: string): string {
  return state === "active" ? "<b>ACTIVE</b>" : e(state);
}

function swarmIndexTable(vm: RunIndexVm): string {
  if (vm.swarms.length === 0) return "";
  const rows = vm.swarms.map((swarm) => [
    link(swarmHref(swarm.id), swarm.id),
    stateCell(swarm.state),
    e(swarm.started ?? ""),
    `${swarm.hordes} x ${num(swarm.count) || "?"}`,
    e(swarm.outcomes.map((outcome, index) => `h${index + 1} ${outcome || "?"}`).join(", ")),
    e(oneLine(swarm.prompt, 100)),
    ...SWARM_FILES.map((name) => yn(swarm.files[name])),
  ]);
  const headers = ["swarm", "state", "started", "hordes", "outcomes", "prompt", ...SWARM_FILES.map((n) => n.toLowerCase())];
  return `<h2>swarms</h2>${table(headers, rows)}<h2>runs</h2>`;
}

export function renderRunIndex(vm: RunIndexVm, ctx: RenderContext): string {
  const rows = vm.runs.map((run) => [
    link(runHref(run.id), run.id),
    run.swarm ? link(swarmHref(run.swarm), run.swarm) : "",
    stateCell(run.state),
    e(run.started ?? ""),
    num(run.count),
    e(run.model ?? ""),
    e(run.outcome ?? ""),
    e(oneLine(run.prompt, 100)),
    ...RUN_FILES.map((name) => yn(run.files[name])),
  ]);
  const headers = ["run", "swarm", "state", "started", "members", "model", "outcome", "prompt", ...RUN_FILES.map((n) => n.toLowerCase())];
  return page("horde runs", [{ text: "runs" }], swarmIndexTable(vm) + table(headers, rows, "no runs in .horde/runs"), ctx);
}

function memberRow(runId: string, m: MemberRowVm): string[] {
  return [
    link(memberHref(runId, m.name), m.name),
    e(m.status),
    m.paused ? "yes" : "",
    e(m.activity),
    String(m.turns),
    String(m.toolCalls),
    formatTokens(m.usage.input),
    formatTokens(m.usage.output),
    `${formatTokens(m.usage.cacheRead)}/${formatTokens(m.usage.cacheWrite)}`,
    cost(m.usage.cost),
    m.elapsedMs === undefined ? "" : formatElapsed(m.elapsedMs),
    e(m.endCause ?? "") +
      (m.partial ? " partial" : "") +
      (m.resets > 0 ? ` reset x${m.resets}` : ""),
    e(oneLine(m.error ?? "", 80)),
  ];
}

const MEMBER_HEADERS = [
  "member", "status", "paused", "activity", "turns", "tool calls", "in", "out", "cache r/w",
  "cost", "elapsed", "end cause", "error",
];

function overviewHeader(vm: RunOverviewVm): string {
  const rows: Array<[string, string]> = [
    ["prompt", pre(vm.prompt)],
    ["model", e(vm.model ?? "")],
    ["thinking", e(vm.thinking ?? "")],
    ["members", String(vm.count)],
    ["started", e(vm.started ?? "")],
    ["elapsed", vm.elapsedMs === undefined ? "" : formatElapsed(vm.elapsedMs)],
    ["outcome", e(vm.outcome ?? "") + (vm.stopLabel && vm.outcome !== vm.stopLabel ? ` (${e(vm.stopLabel)})` : "")],
  ];
  if (vm.finalizing && vm.finalizing.length > 0) {
    rows.push(["finalizing", `${e(vm.finalizing.join(", "))} in progress; files not written yet`]);
  }
  if (vm.cleanStop) {
    const who = vm.cleanStop.members.length > 0 ? vm.cleanStop.members.join(", ") : "all members";
    const left = vm.cleanStop.secondsLeft === undefined ? "" : `hard stop in ${vm.cleanStop.secondsLeft}s: `;
    rows.push(["clean stop", e(`${left}${who}`)]);
  }
  if (vm.canary) rows.push(["canary", e(vm.canary + (vm.canaryError ? ` (${vm.canaryError})` : ""))]);
  if (vm.diagnosis) rows.push(["diagnosis", e(vm.diagnosis)]);
  if (vm.plan && vm.plan.length > 0) rows.push(["plan", pre(vm.plan.join("\n"))]);
  if (vm.runDirMissing) rows.push(["warning", "run dir missing; showing live state only"]);
  return grid(rows);
}

function overviewFiles(vm: RunOverviewVm): string {
  const cells = RUN_FILES.map((name) =>
    vm.files[name] ? link(`${runHref(vm.id)}/files/${name}`, `${name}.md`) : `${name}.md: not yet`,
  );
  return `<p>${cells.join(" | ")}</p>`;
}

function overviewSessions(vm: RunOverviewVm): string {
  if (vm.unmappedSessions.length === 0) return "";
  const rows = vm.unmappedSessions.map((f) => [
    link(`${runHref(vm.id)}/sessions/${encodeURIComponent(f.name)}?from=0&n=50`, f.name),
    String(f.bytes),
  ]);
  return `<h2>unmapped session files (run predates per-member session dirs)</h2>${table(["file", "bytes"], rows)}`;
}

export function renderRunOverview(vm: RunOverviewVm, ctx: RenderContext): string {
  const totals = [
    "<b>total</b>", "", "", "", String(vm.totals.turns), String(vm.members.reduce((n, m) => n + m.toolCalls, 0)),
    formatTokens(vm.totals.input), formatTokens(vm.totals.output), "", cost(vm.totals.cost), "", "", "",
  ];
  const body =
    overviewHeader(vm) +
    `<h2>members: ${vm.counts.running + vm.counts.starting} running, ${vm.counts.done} done, ` +
    `${vm.counts.failed} failed, ${vm.counts.stopped} stopped</h2>` +
    table(MEMBER_HEADERS, [...vm.members.map((m) => memberRow(vm.id, m)), totals]) +
    `<h2>files</h2>${overviewFiles(vm)}` +
    `<p>${link(`${runHref(vm.id)}/sessions`, "all session files")}</p>` +
    overviewSessions(vm);
  return page(`horde ${vm.id}`, [{ text: "runs", href: "/" }, { text: vm.id }], body, ctx);
}

// ---------------------------------------------------------------------------
// Member pages
// ---------------------------------------------------------------------------

export function renderMemberDetail(vm: MemberDetailVm, ctx: RenderContext): string {
  const base = memberHref(vm.runId, vm.name);
  const rows: Array<[string, string]> = [
    ["status", e(vm.status) + (vm.paused ? " (paused)" : "")],
    ["activity", e(vm.activity)],
    ["turns / tool calls", `${vm.turns} / ${vm.toolCalls}`],
    ["tokens in / out", `${formatTokens(vm.usage.input)} / ${formatTokens(vm.usage.output)}`],
    ["cache read / write", `${formatTokens(vm.usage.cacheRead)} / ${formatTokens(vm.usage.cacheWrite)}`],
    ["cost", cost(vm.usage.cost)],
    ["elapsed", vm.elapsedMs === undefined ? "" : formatElapsed(vm.elapsedMs)],
    ["end cause", e(vm.endCause ?? "") + (vm.partial ? " (partial work kept)" : "")],
    ["resets", String(vm.resets)],
    ["exit code", num(vm.exitCode)],
    ["error", e(vm.error ?? "")],
    ["session file", vm.sessionFile ? e(vm.sessionFile) : "none mapped; see " + link(`${runHref(vm.runId)}/sessions`, "session files")],
  ];
  const transcript = vm.sessionFile
    ? `<p>${link(`${base}/transcript?from=last&n=${TRANSCRIPT_PAGE}`, "transcript (tail)")} | ${link(`${base}/transcript?from=0&n=${TRANSCRIPT_PAGE}`, "transcript (start)")}</p>`
    : "";
  const last = vm.lastText ? `<h2>last text</h2>${pre(vm.lastText)}` : "";
  const final = vm.finalText
    ? `<h2>final text${vm.summaryIncomplete ? " (incomplete)" : ""}</h2>${pre(vm.finalText)}`
    : "";
  const log =
    `<h2>${e(vm.name)}.log (last ${vm.logTail.length} of ${vm.logLines} lines; ` +
    `${link(`${base}/log?tail=500`, "more")} | ${link(`${base}/log?tail=0`, "all")})</h2>${pre(vm.logTail.join("\n"))}`;
  const crumbs = [{ text: "runs", href: "/" }, { text: vm.runId, href: runHref(vm.runId) }, { text: vm.name }];
  return page(`${vm.name} of ${vm.runId}`, crumbs, grid(rows) + transcript + last + final + log, ctx);
}

export function renderMemberLog(vm: MemberLogVm, ctx: RenderContext): string {
  const crumbs = [
    { text: "runs", href: "/" },
    { text: vm.runId, href: runHref(vm.runId) },
    { text: vm.name, href: memberHref(vm.runId, vm.name) },
    { text: "log" },
  ];
  const note = vm.truncated ? `<p>showing last ${vm.lines.length} of ${vm.total} lines</p>` : `<p>${vm.total} lines</p>`;
  return page(`${vm.name}.log`, crumbs, note + pre(vm.lines.join("\n")), ctx);
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

const TRANSCRIPT_PAGE = 50;

function transcriptBase(vm: { runId: string; member?: string | undefined; file: string }): string {
  return vm.member
    ? `${memberHref(vm.runId, vm.member)}/transcript`
    : `${runHref(vm.runId)}/sessions/${encodeURIComponent(vm.file)}`;
}

function clock(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? e(iso) : formatClock(date);
}

function partHtml(part: TranscriptPart, entryHref: string, full: boolean, identity: string): string {
  const more = !full ? ` ${link(entryHref, "[full]")}` : " [truncated]";
  switch (part.type) {
    case "text":
      return pre(part.text) + (part.truncated ? more : "");
    case "thinking":
      if (part.thinking === undefined) return details(`thinking (${part.chars} chars)`, `<p>${link(entryHref, "open entry")}</p>`, identity);
      return details(`thinking (${part.chars} chars)`, pre(part.thinking) + (part.truncated ? more : ""), identity);
    case "toolCall":
      return (
        `<p>toolCall <b>${e(part.name)}</b>: ${e(part.summary)}</p>` +
        details("args", pre(part.args) + (part.truncated ? more : ""), identity)
      );
    default:
      return `<p>${e(part.label)}</p>`;
  }
}

function entryRole(entry: TranscriptEntry): string {
  if (entry.kind !== "message") return e(entry.kind);
  const role = e(entry.role ?? "");
  if (entry.role === "toolResult") return `${role}<br>${e(entry.toolName ?? "")}${entry.isError ? " <b>error</b>" : ""}`;
  return role + (entry.stopReason ? `<br>${e(entry.stopReason)}` : "");
}

function entryUsage(entry: TranscriptEntry): string {
  if (!entry.usage) return "";
  return `${formatTokens(entry.usage.input)}/${formatTokens(entry.usage.output)}<br>${cost(entry.usage.cost)}`;
}

function entryRow(entry: TranscriptEntry, base: string, full: boolean, file: string): string[] {
  const href = `${base}/${entry.index}`;
  const content = entry.kind === "message"
    ? entry.parts.map((part, index) => partHtml(part, href, full, `${file}:${href}:${index}`)).join("")
    : e(entry.detail ?? "");
  return [link(href, `#${entry.index}`), clock(entry.timestamp), entryRole(entry), content, entryUsage(entry)];
}

/** The export crawls one page size, so it offers no size links. */
function pagingBar(vm: TranscriptVm, base: string, ctx: RenderContext): string {
  const to = Math.min(vm.total, vm.from + vm.n);
  const go = (from: number | "last", n = vm.n): string => `${base}${query({ from: String(from), n: String(n) })}`;
  const prev = vm.from > 0 ? link(go(Math.max(0, vm.from - vm.n)), "prev") : "prev";
  const next = vm.hasMore ? link(go(vm.from + vm.n), "next") : "next";
  const sizes = ctx.export
    ? ""
    : ` | ${[20, 50, 100].map((n) => (n === vm.n ? `n=${n}` : link(go(vm.from, n), `n=${n}`))).join(" ")}`;
  return (
    `<p>entries ${vm.from}..${to} of ${vm.total} | ${link(go(0), "first")} ${prev} ${next} ` +
    `${link(go("last"), "last")}${sizes}</p>`
  );
}

/** Live pages centre the entry in a short window; the export returns to the crawled page holding it. */
function transcriptPageHref(base: string, index: number, ctx: RenderContext): string {
  if (ctx.export) return `${base}?from=${Math.floor(index / TRANSCRIPT_PAGE) * TRANSCRIPT_PAGE}&n=${TRANSCRIPT_PAGE}`;
  return `${base}?from=${Math.max(0, index - 10)}&n=20`;
}

function transcriptCrumbs(vm: { runId: string; member?: string | undefined; file: string }, leaf: string): Crumb[] {
  const crumbs: Crumb[] = [{ text: "runs", href: "/" }, { text: vm.runId, href: runHref(vm.runId) }];
  if (vm.member) crumbs.push({ text: vm.member, href: memberHref(vm.runId, vm.member) });
  else crumbs.push({ text: "sessions", href: `${runHref(vm.runId)}/sessions` }, { text: vm.file });
  crumbs.push({ text: leaf });
  return crumbs;
}

export function renderTranscript(vm: TranscriptVm, ctx: RenderContext): string {
  const base = transcriptBase(vm);
  const body =
    `<p>file ${e(vm.file)}${vm.sessionId ? `, session ${e(vm.sessionId)}` : ""}${vm.cwd ? `, cwd ${e(vm.cwd)}` : ""}</p>` +
    pagingBar(vm, base, ctx) +
    table(["#", "time", "role", "content", "in/out"], vm.entries.map((entry) => entryRow(entry, base, false, vm.file)), "no entries") +
    pagingBar(vm, base, ctx);
  const title = `${vm.member ?? vm.file} transcript`;
  return page(title, transcriptCrumbs(vm, "transcript"), body, ctx);
}

export function renderTranscriptEntry(vm: TranscriptEntryVm, ctx: RenderContext): string {
  const base = transcriptBase(vm);
  const body =
    `<p>${link(transcriptPageHref(base, vm.entry.index, ctx), "back to transcript")}</p>` +
    table(["#", "time", "role", "content", "in/out"], [entryRow(vm.entry, base, true, vm.file)]) +
    details("raw json", pre(vm.raw), `${base}:${vm.file}:${vm.entry.index}:raw`);
  return page(`entry #${vm.entry.index}`, transcriptCrumbs(vm, `#${vm.entry.index}`), body, ctx);
}

export function renderSessions(vm: SessionsVm, ctx: RenderContext): string {
  const rows = vm.files.map((f) => [
    f.member
      ? link(`${memberHref(vm.runId, f.member)}/transcript?from=0&n=50`, f.name)
      : link(`${runHref(vm.runId)}/sessions/${encodeURIComponent(f.name)}?from=0&n=50`, f.name),
    e(f.sessionId),
    f.member ? link(memberHref(vm.runId, f.member), f.member) : "unmapped",
    String(f.bytes),
    e(new Date(f.mtimeMs).toISOString()),
  ]);
  const crumbs = [{ text: "runs", href: "/" }, { text: vm.runId, href: runHref(vm.runId) }, { text: "sessions" }];
  return page(`sessions of ${vm.runId}`, crumbs, table(["file", "session id", "member", "bytes", "modified"], rows), ctx);
}

export function renderFile(vm: FileVm, ctx: RenderContext): string {
  const parent = vm.swarm ? swarmHref(vm.runId) : runHref(vm.runId);
  const crumbs = [{ text: "runs", href: "/" }, { text: vm.runId, href: parent }, { text: `${vm.name}.md` }];
  const note = vm.truncated ? `<p>showing the first ${vm.content.length} of ${vm.bytes} characters</p>` : "";
  return page(`${vm.name}.md`, crumbs, note + pre(vm.content), ctx);
}

// ---------------------------------------------------------------------------
// Shared boards
// ---------------------------------------------------------------------------

function authorLink(author: string, runId: string | undefined): string {
  return runId && /^member-\d+$/.test(author) ? link(memberHref(runId, author), author) : e(author);
}

function ideaRows(ideas: Idea[], ctx: RenderContext): string[][] {
  return ideas.map((idea) => [
    `<span id="idea-${idea.id}">#${idea.id}</span>`,
    e(idea.text),
    idea.owner ? authorLink(idea.owner, scopeRunId(ctx)) : "",
    e(idea.note ?? ""),
  ]);
}

function ideasBody(vm: IdeasVm, ctx: RenderContext): string {
  const sections: Array<[string, Idea[]]> = [
    ["in progress", vm.inProgress], ["open", vm.open], ["done", vm.done], ["ruled out", vm.ruledOut],
  ];
  return sections
    .map(([title, ideas]) => `<h2>${e(title)} (${ideas.length})</h2>${table(["id", "idea", "owner", "note"], ideaRows(ideas, ctx))}`)
    .join("");
}

export function renderIdeas(vm: IdeasVm, ctx: RenderContext): string {
  const base = `${scopeBase(ctx.scope)}/ideas`;
  const filters = [
    vm.owner ? link(base, "all") : "all",
    ...vm.owners.map((o) => (o === vm.owner ? e(o) : link(`${base}${query({ owner: o })}`, o))),
  ];
  return page("ideas", [{ text: "ideas" }], `<p>owner: ${filters.join(" ")}</p>${ideasBody(vm, ctx)}`, ctx);
}

function boardBody(vm: BoardVm, ctx: RenderContext): string {
  const rows = vm.entries.map((entry: BoardEntry) => [
    entry.runId ? link(runHref(entry.runId), entry.runId) : "",
    e(entry.time),
    authorLink(entry.author, entry.runId || scopeRunId(ctx)),
    pre(entry.text),
  ]);
  return table(["run", "time", "author", "message"], rows, "no posts");
}

export function renderBoard(vm: BoardVm, ctx: RenderContext): string {
  const other = vm.order === "newest" ? "oldest" : "newest";
  const body =
    `<p>order: ${vm.order} ${link(`${scopeBase(ctx.scope)}/board${query({ order: other })}`, `[${other} first]`)}</p>` +
    boardBody(vm, ctx);
  return page("board", [{ text: "board" }], body, ctx);
}

/** The findings page of the scope this finding is shown in, with a body opened or closed. */
function findingsHref(vm: FindingsVm, ctx: RenderContext, open: number[]): string {
  return `${scopeBase(ctx.scope)}/findings${query({ view: vm.view, open: open.length > 0 ? open.join(",") : undefined })}`;
}

/** The body is expanded when its id is in the URL, so the state survives auto-refresh; the export shows it inline. */
function findingBody(f: FindingEntry, vm: FindingsVm, ctx: RenderContext): string {
  if (!f.body) return "";
  if (ctx.export) return pre(f.body);
  if (vm.open.includes(f.id)) {
    return pre(f.body) + link(findingsHref(vm, ctx, vm.open.filter((id) => id !== f.id)), "[hide body]");
  }
  return ` ${link(findingsHref(vm, ctx, [...vm.open, f.id]), "[show body]")}`;
}

function findingRow(f: FindingEntry, vm: FindingsVm, ctx: RenderContext): string[] {
  const ideas = f.runId ? `${runHref(f.runId)}/ideas` : "/ideas";
  const idea = f.ideaId === undefined ? "" : link(`${ideas}#idea-${f.ideaId}`, `#${f.ideaId}`);
  const authors = [f.author, ...f.corroborators].map((a) => authorLink(a, f.runId)).join(", ");
  const title = (f.supersededBy !== undefined ? "<b>SUPERSEDED</b> " : "") + e(f.title);
  return [
    `<span id="F${f.id}">F${f.id}</span>`,
    f.runId ? link(runHref(f.runId), f.runId) : "",
    authors,
    e(f.importance ?? ""),
    e(f.confidence ?? ""),
    e(f.support ?? ""),
    e(f.concern ?? ""),
    idea,
    f.deltaOf === undefined ? "" : link(`#F${f.deltaOf}`, `F${f.deltaOf}`),
    f.supersedes === undefined ? "" : link(`#F${f.supersedes}`, `F${f.supersedes}`),
    f.supersededBy === undefined ? "" : link(`#F${f.supersededBy}`, `F${f.supersededBy}`),
    e(vm.reviewStates?.[f.id] ?? (f.verifiedBy ? `legacy (${f.verifiedBy})` : "unreviewed")),
    title + findingBody(f, vm, ctx),
  ];
}

const FINDING_HEADERS = [
  "id", "run", "authors", "imp", "conf", "support", "concern", "idea", "delta of", "supersedes",
  "superseded by", "review status", "title",
];

function findingsBody(vm: FindingsVm, ctx: RenderContext): string {
  if (!vm.clusters) return table(FINDING_HEADERS, vm.findings.map((f) => findingRow(f, vm, ctx)), "no findings");
  if (vm.clusters.length === 0) return "<p>no findings</p>";
  return vm.clusters
    .map((cluster, i) => {
      const members = cluster.members.join(", ") || "none";
      const deltas = cluster.deltaMembers.length > 0 ? `; deltas ${cluster.deltaMembers.join(", ")}` : "";
      return (
        `<h2>cluster ${i + 1}: F${cluster.representative}, members ${e(members)}${e(deltas)}</h2>` +
        table(FINDING_HEADERS, cluster.findings.map((f) => findingRow(f, vm, ctx)))
      );
    })
    .join("");
}

export function renderFindings(vm: FindingsVm, ctx: RenderContext): string {
  const other = vm.view === "list" ? "clusters" : "list";
  const open = vm.open.length > 0 ? vm.open.join(",") : undefined;
  const body =
    `<p>view: ${vm.view} ${link(`${scopeBase(ctx.scope)}/findings${query({ view: other, open })}`, `[${other}]`)}</p>` +
    findingsBody(vm, ctx);
  return page("findings", [{ text: "findings" }], body, ctx);
}

function claimsBody(vm: ClaimsVm, ctx: RenderContext): string {
  const body = vm.groups
    .map(
      (group) =>
        `<h2>${e(group.state)} (${group.claims.length})</h2>` +
        table(
          ["id", "statement", "owner", "notes"],
          group.claims.map((c: ClaimEntry) => [anchor(`C${c.id}`), e(c.statement), authorLink(c.owner, scopeRunId(ctx)), e(c.notes.join(" | "))]),
        ),
    )
    .join("");
  return body || "<p>no claims</p>";
}

export function renderClaims(vm: ClaimsVm, ctx: RenderContext): string {
  return page("claims", [{ text: "claims" }], claimsBody(vm, ctx), ctx);
}

function factRows(facts: FactEntry[], ctx: RenderContext): string[][] {
  return facts.map((f) => [
    anchor(`T${f.id}`),
    e(f.text),
    authorLink(f.author, scopeRunId(ctx)),
    f.deltaOf === undefined ? "" : `T${f.deltaOf}`,
  ]);
}

function factsBody(vm: FactsVm, ctx: RenderContext): string {
  const headers = ["id", "fact", "author", "delta of"];
  return vm.attribution === "split"
    ? `<h2>this run (${vm.thisRun.length})</h2>${table(headers, factRows(vm.thisRun, ctx))}` +
      `<h2>carried from earlier runs (${vm.carried.length})</h2>${table(headers, factRows(vm.carried, ctx))}`
    : `<p>${vm.run ? "per-run attribution is only available for the active run; " : ""}all facts:</p>` +
      table(headers, factRows(vm.all, ctx), "no facts");
}

export function renderFacts(vm: FactsVm, ctx: RenderContext): string {
  return page("facts", [{ text: "facts" }], factsBody(vm, ctx), ctx);
}

function resourcesBody(vm: ResourcesVm, ctx: RenderContext): string {
  const rows = vm.resources.map((resource) => [
    anchor(`R${resource.id}`),
    e(resource.name),
    authorLink(resource.owner, scopeRunId(ctx)),
    e(resource.note ?? ""),
    resource.reusers.map((name) => authorLink(name, scopeRunId(ctx))).join(", "),
    resource.citedBy.map((name) => authorLink(name, scopeRunId(ctx))).join(", "),
    e(resource.cleanup ?? ""),
  ]);
  const scope = vm.run
    ? `<p>cited by: non-owners whose findings, evidence, reviews or leases name the resource in run ${e(vm.run)}</p>`
    : "<p>cited by: needs an active run; only explicit reclaims are shown</p>";
  return scope + table(["id", "name", "owner", "note", "reused by", "cited by", "cleanup"], rows, "no shared resources claimed");
}

export function renderResources(vm: ResourcesVm, ctx: RenderContext): string {
  return page("resources", [{ text: "resources" }], resourcesBody(vm, ctx), ctx);
}

// ---------------------------------------------------------------------------
// Swarm ledgers: every horde's ledger on one page, under per-horde headings
// ---------------------------------------------------------------------------

/** Render a ledger aggregated across a swarm: one `<h2>hN</h2>` section per horde, ids stay unambiguous. */
function swarmLedgerPage<T>(
  kind: string,
  vm: SwarmLedgerVm<T>,
  body: (sectionVm: T, ctx: RenderContext) => string,
  ctx: RenderContext,
): string {
  const crumbs: Crumb[] = [{ text: "runs", href: "/" }, { text: `swarm ${vm.swarmId}`, href: swarmHref(vm.swarmId) }, { text: kind }];
  // Links inside a section (member names, finding bodies, idea anchors) belong to that horde.
  const sectionCtx = (runId: string): RenderContext => ({ ...ctx, scope: { kind: "run", runId } });
  const inner =
    vm.sections.length === 0
      ? "<p>this swarm has no hordes</p>"
      : `<p>${kind} across ${vm.sections.length} hordes; ids repeat per horde, so each section is one horde's ledger</p>` +
        vm.sections
          .map((section) =>
            `<h2>${e(section.label)} &mdash; ${link(pageHref(runHref(section.runId), ctx.pageKind), section.runId)}</h2>` +
            body(section.vm, sectionCtx(section.runId)))
          .join("");
  return page(kind, crumbs, inner, ctx);
}

export function renderSwarmIdeas(vm: SwarmLedgerVm<IdeasVm>, ctx: RenderContext): string {
  return swarmLedgerPage("ideas", vm, ideasBody, ctx);
}

export function renderSwarmBoard(vm: SwarmLedgerVm<BoardVm>, ctx: RenderContext): string {
  return swarmLedgerPage("board", vm, boardBody, ctx);
}

export function renderSwarmFindings(vm: SwarmLedgerVm<FindingsVm>, ctx: RenderContext): string {
  return swarmLedgerPage("findings", vm, findingsBody, ctx);
}

export function renderSwarmClaims(vm: SwarmLedgerVm<ClaimsVm>, ctx: RenderContext): string {
  return swarmLedgerPage("claims", vm, claimsBody, ctx);
}

export function renderSwarmFacts(vm: SwarmLedgerVm<FactsVm>, ctx: RenderContext): string {
  return swarmLedgerPage("facts", vm, factsBody, ctx);
}

export function renderSwarmResources(vm: SwarmLedgerVm<ResourcesVm>, ctx: RenderContext): string {
  return swarmLedgerPage("resources", vm, resourcesBody, ctx);
}

// ---------------------------------------------------------------------------
// Run graph
// ---------------------------------------------------------------------------

const GRAPH_WIDTHS = [800, 1200, 2400, 4800];

function graphHref(runId: string, view: RunGraphVm["view"]): string {
  const seconds = (ms: number): string | undefined => (ms > 0 ? String(Math.round(ms / 1000)) : undefined);
  return `${runHref(runId)}/graph${query({ w: String(view.width), from: seconds(view.from), to: seconds(view.to) })}`;
}

function graphWindowLine(vm: RunGraphVm): string {
  const { view } = vm;
  if (view.from <= 0 && view.to <= 0) {
    return "window: whole run (add ?from=&lt;s&gt;&amp;to=&lt;s&gt;, seconds from the start, to zoom)";
  }
  const end = view.to > 0 ? `+${formatElapsed(view.to)}` : "end";
  return `window: +${formatElapsed(view.from)} to ${end} ${link(graphHref(vm.runId, { width: view.width, from: 0, to: 0 }), "[whole run]")}`;
}

export function renderGraph(vm: RunGraphVm, ctx: RenderContext): string {
  const { graph, view } = vm;
  const crumbs: Crumb[] = [{ text: "runs", href: "/" }, { text: vm.runId, href: runHref(vm.runId) }, { text: "graph" }];
  if (vm.empty) return page(`graph ${vm.runId}`, crumbs, "<p>no events recorded for this run</p>", ctx);
  const entities = graph.nodes.filter((node) => !node.marker).length;
  const summary =
    `${entities} entities, ${graph.nodes.length - entities} actions, ${graph.edges.length} edges, ` +
    `${graph.lanes.length} lanes, ${formatElapsed(graph.end - graph.start)} elapsed; ` +
    `phases: ${graph.phases.map((phase) => phase.id).join(", ") || "none"}`;
  const widths = GRAPH_WIDTHS.map((width) =>
    width === view.width ? String(width) : link(graphHref(vm.runId, { ...view, width }), String(width)),
  );
  const body =
    `<p>${e(summary)}</p>` +
    `<p>width: ${widths.join(" ")} | ${graphWindowLine(vm)} | ${link(`${runHref(vm.runId)}/graph.mmd`, "mermaid export")}</p>` +
    graphLegendHtml() +
    `<div class="graph">${renderRunGraphSvg(graph, view)}</div>`;
  return page(`graph ${vm.runId}`, crumbs, body, ctx);
}

/** The text/plain Mermaid export; links are absolute so the file works outside the dashboard. */
export function renderGraphMermaid(vm: RunGraphVm, ctx: RenderContext): string {
  return renderRunGraphMermaid(vm.graph, ctx.origin ?? "");
}

// ---------------------------------------------------------------------------
// Swarms
// ---------------------------------------------------------------------------

const SWARM_HORDE_HEADERS = [
  "horde", "run", "state", "outcome", "members", "running", "done", "failed", "stopped", "turns", "in", "out",
  "cost", "findings", "accepted artifacts", "elapsed", "workstream",
];

function swarmHordeRow(row: SwarmVm["rows"][number]): string[] {
  return [
    e(row.label),
    link(runHref(row.runId), row.runId),
    stateCell(row.state),
    e(row.outcome ?? ""),
    String(row.count),
    String(row.counts.running + row.counts.starting),
    String(row.counts.done),
    String(row.counts.failed),
    String(row.counts.stopped),
    String(row.totals.turns),
    formatTokens(row.totals.input),
    formatTokens(row.totals.output),
    cost(row.totals.cost),
    String(row.findings),
    String(row.acceptedArtifacts),
    row.elapsedMs === undefined ? "" : formatElapsed(row.elapsedMs),
    e(oneLine(row.slice ?? "", 120)),
  ];
}

function swarmHeader(vm: SwarmVm): string {
  const rows: Array<[string, string]> = [
    ["state", stateCell(vm.state) + (vm.state === "pending" ? " (the planner is partitioning the task, or the launch did not reach the hordes)" : "")],
    ["prompt", pre(vm.prompt)],
    ["hordes", `${vm.hordes} x ${vm.count ?? "?"} members`],
    ["started", e(vm.started ?? "")],
    ["elapsed", vm.elapsedMs === undefined ? "" : formatElapsed(vm.elapsedMs)],
    ["until stop", vm.untilStop ? "yes" : "no"],
    ["merge", e(vm.merge)],
  ];
  if (vm.notStarted) rows.push(["not started", e(vm.notStarted)]);
  if (vm.partition.length > 0) {
    rows.push(["partition", pre(vm.partition.map((slice, index) => `h${index + 1}: ${slice}`).join("\n"))]);
  }
  return grid(rows);
}

function swarmFiles(vm: SwarmVm): string {
  const cells = SWARM_FILES.map((name) =>
    vm.files[name] ? link(`${swarmHref(vm.id)}/files/${name}`, `${name}.md`) : `${name}.md: not yet`,
  );
  return `<p>${cells.join(" | ")} | ${link(`${swarmHref(vm.id)}/graph`, "swarm graph")}</p>`;
}

export function renderSwarm(vm: SwarmVm, ctx: RenderContext): string {
  const totals = [
    "<b>total</b>", "", "", "",
    String(vm.rows.reduce((n, r) => n + r.count, 0)),
    String(vm.rows.reduce((n, r) => n + r.counts.running + r.counts.starting, 0)),
    String(vm.rows.reduce((n, r) => n + r.counts.done, 0)),
    String(vm.rows.reduce((n, r) => n + r.counts.failed, 0)),
    String(vm.rows.reduce((n, r) => n + r.counts.stopped, 0)),
    String(vm.rows.reduce((n, r) => n + r.totals.turns, 0)),
    formatTokens(vm.rows.reduce((n, r) => n + r.totals.input, 0)),
    formatTokens(vm.rows.reduce((n, r) => n + r.totals.output, 0)),
    cost(vm.rows.reduce((n, r) => n + r.totals.cost, 0)),
    String(vm.rows.reduce((n, r) => n + r.findings, 0)),
    String(vm.rows.reduce((n, r) => n + r.acceptedArtifacts, 0)),
    "", "",
  ];
  const body =
    swarmHeader(vm) +
    `<h2>hordes</h2>` +
    table(SWARM_HORDE_HEADERS, [...vm.rows.map(swarmHordeRow), totals], "no hordes started") +
    `<h2>files</h2>${swarmFiles(vm)}`;
  return page(`swarm ${vm.id}`, [{ text: "runs", href: "/" }, { text: `swarm ${vm.id}` }], body, ctx);
}

function swarmGraphHref(swarmId: string, view: SwarmGraphVm["view"]): string {
  const seconds = (ms: number): string | undefined => (ms > 0 ? String(Math.round(ms / 1000)) : undefined);
  return `${swarmHref(swarmId)}/graph${query({ w: String(view.width), from: seconds(view.from), to: seconds(view.to) })}`;
}

/** One lane per horde with its phases, and the merge step in the swarm lane. */
export function renderSwarmGraph(vm: SwarmGraphVm, ctx: RenderContext): string {
  const { graph, view } = vm;
  const crumbs: Crumb[] = [{ text: "runs", href: "/" }, { text: `swarm ${vm.swarmId}`, href: swarmHref(vm.swarmId) }, { text: "graph" }];
  if (vm.empty) return page(`swarm graph ${vm.swarmId}`, crumbs, "<p>no events recorded for this swarm's hordes</p>", ctx);
  const widths = GRAPH_WIDTHS.map((width) =>
    width === view.width ? String(width) : link(swarmGraphHref(vm.swarmId, { ...view, width }), String(width)),
  );
  const summary =
    `${graph.lanes.length - 1} hordes, ${graph.nodes.length} lifecycle marks, ${formatElapsed(graph.end - graph.start)} elapsed; ` +
    "each horde's own graph is on its run page";
  const body =
    `<p>${e(summary)}</p>` +
    `<p>width: ${widths.join(" ")}</p>` +
    `<div class="graph">${renderRunGraphSvg(graph, view)}</div>`;
  return page(`swarm graph ${vm.swarmId}`, crumbs, body, ctx);
}
