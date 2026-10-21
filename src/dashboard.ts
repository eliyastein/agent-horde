import * as http from "node:http";
import {
  DashboardError,
  latestRunId,
  listRunSessions,
  listRuns,
  loadBoard,
  loadClaims,
  loadCollaboration,
  loadFacts,
  loadFindings,
  loadIdeas,
  loadMemberDetail,
  loadMemberLog,
  loadRunFile,
  loadRunGraph,
  loadRunOverview,
  loadResources,
  loadSessionEntry,
  loadSessionTranscript,
  loadTranscript,
  loadTranscriptEntry,
  MEMBER_RE,
  RUN_ID_RE,
} from "./dashboard-data.js";
import type { DashboardSource, GraphView } from "./dashboard-data.js";
import {
  renderBoard,
  renderClaims,
  renderCollaboration,
  renderError,
  renderExportStart,
  renderFacts,
  renderFile,
  renderFindings,
  renderGraph,
  renderGraphMermaid,
  renderIdeas,
  renderMemberDetail,
  renderMemberLog,
  renderRunIndex,
  renderRunOverview,
  renderResources,
  renderSessions,
  renderTranscript,
  renderTranscriptEntry,
} from "./dashboard-html.js";
import type { RenderContext } from "./dashboard-html.js";
import { collect, exportDashboard } from "./dashboard-export.js";
import type { ExportPage } from "./dashboard-export.js";

const DEFAULT_PORT = 7433;
const EXPORT_PAGE = "/export";
const EXPORT_PATH = "/export.zip";
const REFRESH_SECONDS = 3;
const MAX_URL_LENGTH = 4096;
const CLOSE_GUARD_MS = 2_000;
const HOST_RE = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/;

interface DashboardResponse {
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
  /** Written after the headers in place of `body`, as it is produced. */
  stream?: AsyncIterable<Buffer> | undefined;
}

interface Route {
  pattern: RegExp;
  /** Whether the page auto-refreshes; evaluated on the loaded view model. */
  live: (vm: unknown, src: DashboardSource, params: string[], query: URLSearchParams) => boolean;
  load: (src: DashboardSource, params: string[], query: URLSearchParams) => unknown;
  render: (vm: never, ctx: RenderContext) => string;
  /** Serve the renderer's output as text/plain instead of a page. */
  text?: boolean;
}

function queryEnum<T extends string>(query: URLSearchParams, key: string, allowed: readonly T[], fallback: T): T {
  const value = query.get(key);
  if (value === null) return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new DashboardError(400, `invalid ${key}: ${value}`);
  return value as T;
}

function queryInt(query: URLSearchParams, key: string, min: number, max: number, fallback: number): number {
  const value = query.get(key);
  if (value === null) return fallback;
  if (!/^\d{1,9}$/.test(value)) throw new DashboardError(400, `invalid ${key}: ${value}`);
  const n = Number(value);
  if (n < min || n > max) throw new DashboardError(400, `${key} must be ${min}..${max}`);
  return n;
}

function queryIds(query: URLSearchParams, key: string): number[] {
  const value = query.get(key);
  if (value === null || value === "") return [];
  if (!/^\d{1,9}(,\d{1,9})*$/.test(value)) throw new DashboardError(400, `invalid ${key}: ${value}`);
  return Array.from(new Set(value.split(",").map(Number)));
}

function queryFrom(query: URLSearchParams): number | "last" {
  return query.get("from") === "last" ? "last" : queryInt(query, "from", 0, 999_999_999, 0);
}

function queryRun(query: URLSearchParams): string {
  const value = query.get("run") ?? "all";
  if (value !== "all" && !RUN_ID_RE.test(value)) throw new DashboardError(400, `invalid run: ${value}`);
  return value;
}

function queryOwner(query: URLSearchParams): string | undefined {
  const value = query.get("owner");
  if (value === null || value === "") return undefined;
  if (value !== "parent" && !MEMBER_RE.test(value)) throw new DashboardError(400, `invalid owner: ${value}`);
  return value;
}

function isActive(src: DashboardSource, runId: string | undefined): boolean {
  return runId !== undefined && src.getActive()?.id === runId;
}

function isFinalizing(src: DashboardSource, runId: string | undefined): boolean {
  return runId !== undefined && src.getFinalizing?.()?.id === runId;
}

function memberRunning(src: DashboardSource, runId: string, member: string): boolean {
  const state = src.getActive()?.members.find((m) => m.name === member);
  return isActive(src, runId) && state !== undefined && (state.status === "running" || state.status === "starting");
}

const p = (params: string[], i: number): string => params[i] ?? "";

const GRAPH_WIDTH_DEFAULT = 1200;

/** `w` in pixels; `from` and `to` in seconds from the run start. */
function graphView(query: URLSearchParams): GraphView {
  return {
    width: queryInt(query, "w", 400, 8000, GRAPH_WIDTH_DEFAULT),
    from: queryInt(query, "from", 0, 999_999, 0) * 1000,
    to: queryInt(query, "to", 0, 999_999, 0) * 1000,
  };
}

const ROUTES: Route[] = [
  {
    pattern: /^\/$/,
    live: () => true,
    load: (src) => listRuns(src),
    render: renderRunIndex,
  },
  {
    pattern: /^\/runs\/([^/]+)$/,
    live: (_vm, src, params) => isActive(src, p(params, 0)) || isFinalizing(src, p(params, 0)),
    load: (src, params) => loadRunOverview(src, p(params, 0)),
    render: renderRunOverview,
  },
  {
    pattern: /^\/runs\/([^/]+)\/collaboration$/,
    live: (_vm, src, params) => isActive(src, p(params, 0)),
    load: (src, params, query) => loadCollaboration(src, p(params, 0), queryInt(query, "from", 0, 999_999_999, 0)),
    render: renderCollaboration,
  },
  {
    pattern: /^\/runs\/([^/]+)\/graph$/,
    live: (_vm, src, params) => isActive(src, p(params, 0)) || isFinalizing(src, p(params, 0)),
    load: (src, params, query) => loadRunGraph(src, p(params, 0), graphView(query)),
    render: renderGraph,
  },
  {
    pattern: /^\/runs\/([^/]+)\/graph\.mmd$/,
    live: () => false,
    load: (src, params) => loadRunGraph(src, p(params, 0), { width: GRAPH_WIDTH_DEFAULT, from: 0, to: 0 }),
    render: renderGraphMermaid,
    text: true,
  },
  {
    pattern: /^\/runs\/([^/]+)\/members\/([^/]+)$/,
    live: (_vm, src, params) => memberRunning(src, p(params, 0), p(params, 1)),
    load: (src, params, query) => loadMemberDetail(src, p(params, 0), p(params, 1), queryInt(query, "tail", 1, 2000, 60)),
    render: renderMemberDetail,
  },
  {
    pattern: /^\/runs\/([^/]+)\/members\/([^/]+)\/log$/,
    live: () => false,
    load: (src, params, query) => loadMemberLog(src, p(params, 0), p(params, 1), queryInt(query, "tail", 0, 2000, 500)),
    render: renderMemberLog,
  },
  {
    pattern: /^\/runs\/([^/]+)\/members\/([^/]+)\/transcript$/,
    live: (_vm, src, params, query) => query.get("from") === "last" && memberRunning(src, p(params, 0), p(params, 1)),
    load: (src, params, query) =>
      loadTranscript(src, p(params, 0), p(params, 1), queryFrom(query), queryInt(query, "n", 1, 200, 50)),
    render: renderTranscript,
  },
  {
    pattern: /^\/runs\/([^/]+)\/members\/([^/]+)\/transcript\/(\d{1,9})$/,
    live: () => false,
    load: (src, params) => loadTranscriptEntry(src, p(params, 0), p(params, 1), Number(p(params, 2))),
    render: renderTranscriptEntry,
  },
  {
    pattern: /^\/runs\/([^/]+)\/sessions$/,
    live: (_vm, src, params) => isActive(src, p(params, 0)),
    load: (src, params) => listRunSessions(src, p(params, 0)),
    render: renderSessions,
  },
  {
    pattern: /^\/runs\/([^/]+)\/sessions\/([^/]+)$/,
    live: () => false,
    load: (src, params, query) =>
      loadSessionTranscript(src, p(params, 0), p(params, 1), queryFrom(query), queryInt(query, "n", 1, 200, 50)),
    render: renderTranscript,
  },
  {
    pattern: /^\/runs\/([^/]+)\/sessions\/([^/]+)\/(\d{1,9})$/,
    live: () => false,
    load: (src, params) => loadSessionEntry(src, p(params, 0), p(params, 1), Number(p(params, 2))),
    render: renderTranscriptEntry,
  },
  {
    pattern: /^\/runs\/([^/]+)\/files\/([^/]+)$/,
    live: () => false,
    load: (src, params) => {
      const vm = loadRunFile(src, p(params, 0), p(params, 1));
      if (!vm.present) throw new DashboardError(404, `${vm.name}.md has not been written yet`);
      return vm;
    },
    render: renderFile,
  },
  {
    pattern: /^\/ideas$/,
    live: () => true,
    load: (src, _params, query) => loadIdeas(src, queryOwner(query)),
    render: renderIdeas,
  },
  {
    pattern: /^\/board$/,
    live: () => true,
    load: (src, _params, query) =>
      loadBoard(src, queryRun(query), queryEnum(query, "order", ["newest", "oldest"] as const, "newest")),
    render: renderBoard,
  },
  {
    pattern: /^\/findings$/,
    live: () => true,
    load: (src, _params, query) =>
      loadFindings(
        src,
        queryRun(query),
        queryEnum(query, "view", ["list", "clusters"] as const, "list"),
        queryIds(query, "open"),
      ),
    render: renderFindings,
  },
  {
    pattern: /^\/claims$/,
    live: () => true,
    load: (src) => loadClaims(src),
    render: renderClaims,
  },
  {
    pattern: /^\/facts$/,
    live: () => true,
    load: (src, _params, query) => {
      const run = queryRun(query);
      return loadFacts(src, run === "all" ? undefined : run);
    },
    render: renderFacts,
  },
  {
    pattern: /^\/resources$/,
    live: () => true,
    load: (src) => loadResources(src),
    render: renderResources,
  },
];

function baseHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
  };
}

function respond(status: number, contentType: string, body: string, extra: Record<string, string> = {}): DashboardResponse {
  return { status, contentType, body, headers: { ...baseHeaders(), ...extra } };
}

/** A same-origin dashboard path, else `/`; the export page returns here. */
function backPath(query: URLSearchParams): string {
  const back = query.get("back") ?? "/";
  return /^\/(?![/\\])[^\s]{0,2000}$/.test(back) ? back : "/";
}

function parentPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/"));
  return parent === "" ? "/" : parent;
}

function errorResponse(status: number, message: string, url: URL, json: boolean, ctx: RenderContext): DashboardResponse {
  if (json) return respond(status, "application/json; charset=utf-8", JSON.stringify({ status, error: message }));
  return respond(status, "text/html; charset=utf-8", renderError(status, message, parentPath(url.pathname), ctx));
}

function refreshToggle(url: URL, on: boolean): string {
  const next = new URL(url.toString());
  if (on) next.searchParams.set("refresh", "0");
  else next.searchParams.delete("refresh");
  return `${next.pathname}${next.search}`;
}

function decodeParams(match: RegExpExecArray): string[] {
  try {
    return match.slice(1).map((value) => decodeURIComponent(value));
  } catch {
    throw new DashboardError(400, "malformed path encoding");
  }
}

function routeMatch(pathname: string): { route: Route; params: string[] } | undefined {
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (match) return { route, params: decodeParams(match) };
  }
  return undefined;
}

/** The run this page belongs to, and the run the nav's collaboration and graph links target. */
function runContext(src: DashboardSource, url: URL, params: string[]): Pick<RenderContext, "runId" | "navRun"> {
  const runId = RUN_ID_RE.test(params[0] ?? "") ? params[0] : undefined;
  const filterRun = url.searchParams.get("run");
  const navRun = runId ?? (filterRun && RUN_ID_RE.test(filterRun) ? filterRun : undefined) ?? latestRunId(src);
  return { runId, navRun };
}

/** The export costs seconds of work per request, so pages from other sites may not start one. */
function handleRoute(src: DashboardSource, url: URL, json: boolean, ctx: RenderContext, crossSite: boolean): DashboardResponse {
  const pathname = json ? url.pathname.slice("/api".length) || "/" : url.pathname;
  if (!json && (pathname === EXPORT_PATH || pathname === EXPORT_PAGE)) {
    if (crossSite) return errorResponse(403, "the export can only be started from the dashboard itself", url, json, ctx);
    if (pathname === EXPORT_PATH) return exportResponse(src, url, ctx);
    return respond(200, "text/html; charset=utf-8", renderExportStart(EXPORT_PATH, backPath(url.searchParams), ctx));
  }
  const matched = routeMatch(pathname);
  if (!matched) throw new DashboardError(404, `no such page: ${pathname}`);
  const { route, params } = matched;
  const refreshParam = queryEnum(url.searchParams, "refresh", ["0", String(REFRESH_SECONDS)] as const, String(REFRESH_SECONDS));
  const vm = route.load(src, params, url.searchParams);
  if (json) return respond(200, "application/json; charset=utf-8", JSON.stringify(vm));
  const live = route.live(vm, src, params, url.searchParams);
  const on = live && refreshParam !== "0";
  const pageCtx: RenderContext = {
    ...ctx,
    ...runContext(src, url, params),
    refresh: live ? { on, toggleHref: refreshToggle(url, on), seconds: REFRESH_SECONDS } : undefined,
  };
  const body = route.render(vm as never, pageCtx);
  if (route.text) return respond(200, "text/plain; charset=utf-8", body);
  return respond(200, "text/html; charset=utf-8", body);
}

/** One page of the static export; errors become pages so no exported link dangles. */
function exportPage(src: DashboardSource, url: URL): ExportPage {
  const ctx: RenderContext = { activeId: src.getActive()?.id, href: url.pathname + url.search, export: true };
  try {
    const matched = routeMatch(url.pathname);
    if (!matched) throw new DashboardError(404, `no such page: ${url.pathname}`);
    const { route, params } = matched;
    const vm = route.load(src, params, url.searchParams);
    return { body: route.render(vm as never, { ...ctx, ...runContext(src, url, params) }), text: route.text };
  } catch (error) {
    const status = error instanceof DashboardError ? error.status : 500;
    const message = error instanceof DashboardError ? error.message : `dashboard error: ${error instanceof Error ? error.message : String(error)}`;
    return { body: renderError(status, message, parentPath(url.pathname), ctx) };
  }
}

/** The whole dashboard as a zip of static pages, streamed as it is built, named for the moment it was taken. */
export function exportDashboardArchive(src: DashboardSource, now = new Date()): { filename: string; zip: AsyncGenerator<Buffer> } {
  const folder = `horde-dashboard-${now.toISOString().slice(0, 19).replace(/[T:]/g, "-")}`;
  return { filename: `${folder}.zip`, zip: exportDashboard((url) => exportPage(src, url), folder, now) };
}

/** The finished archive in one buffer. */
export async function exportDashboardBuffer(src: DashboardSource, now = new Date()): Promise<{ filename: string; zip: Buffer }> {
  const { filename, zip } = exportDashboardArchive(src, now);
  return { filename, zip: await collect(zip) };
}

let exporting = false;

/** Marks the export busy from its first chunk until the stream ends or its reader goes away. */
async function* exclusive(stream: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  exporting = true;
  try {
    yield* stream;
  } finally {
    exporting = false;
  }
}

/** Headers go out at once so the browser shows the download while the pages are still being packed; one at a time. */
function exportResponse(src: DashboardSource, url: URL, ctx: RenderContext): DashboardResponse {
  if (exporting) return errorResponse(503, "an export is already in progress; wait for it to finish", url, false, ctx);
  const { filename, zip } = exportDashboardArchive(src);
  return { ...respond(200, "application/zip", "", { "Content-Disposition": `attachment; filename="${filename}"` }), stream: exclusive(zip) };
}

/** Pure request handler: validates method and host, dispatches, maps errors to responses. `fetchSite` is the Sec-Fetch-Site header. */
export function routeRequest(src: DashboardSource, method: string, url: URL, host: string | undefined, fetchSite?: string): DashboardResponse {
  const json = url.pathname === "/api" || url.pathname.startsWith("/api/");
  const ctx: RenderContext = {
    activeId: src.getActive()?.id,
    origin: host ? `http://${host}` : undefined,
    href: url.pathname + url.search,
  };
  try {
    if (method !== "GET" && method !== "HEAD") {
      return { ...errorResponse(405, `method ${method} not allowed`, url, json, ctx), headers: { ...baseHeaders(), Allow: "GET, HEAD" } };
    }
    if (!host || !HOST_RE.test(host)) return errorResponse(403, "host must be 127.0.0.1 or localhost", url, json, ctx);
    if (url.href.length > MAX_URL_LENGTH) return errorResponse(414, "url too long", url, json, ctx);
    return handleRoute(src, url, json, ctx, fetchSite === "cross-site");
  } catch (error) {
    if (error instanceof DashboardError) return errorResponse(error.status, error.message, url, json, ctx);
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(500, `dashboard error: ${message}`, url, json, ctx);
  }
}

export interface DashboardServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface StartDashboardOptions {
  port: number;
  source: DashboardSource;
  onError?: ((error: Error) => void) | undefined;
}

export function resolveDashboardPort(requested?: number): number {
  return requested ?? (Number(process.env.PI_HORDE_DASHBOARD_PORT) || DEFAULT_PORT);
}

function listenError(error: NodeJS.ErrnoException, port: number): Error {
  if (error.code === "EADDRINUSE") {
    return new Error(`dashboard port ${port} is in use; pass --dashboard=<port> or set PI_HORDE_DASHBOARD_PORT`);
  }
  if (error.code === "EACCES") return new Error(`dashboard port ${port} is not permitted; pick a port above 1024`);
  return new Error(`dashboard could not listen on ${port}: ${error.message}`);
}

const drained = (res: http.ServerResponse): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });

/** Writes the chunks as they come, pausing for the client; a failure mid-stream cuts the connection. */
async function streamBody(res: http.ServerResponse, stream: AsyncIterable<Buffer>): Promise<void> {
  try {
    for await (const chunk of stream) {
      if (res.destroyed) return;
      if (!res.write(chunk)) await drained(res);
    }
    res.end();
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

function serve(src: DashboardSource, req: http.IncomingMessage, res: http.ServerResponse): void {
  req.resume();
  res.on("error", () => {});
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const fetchSite = req.headers["sec-fetch-site"];
  const response = routeRequest(src, req.method ?? "GET", url, req.headers.host, Array.isArray(fetchSite) ? fetchSite[0] : fetchSite);
  res.writeHead(response.status, { ...response.headers, "Content-Type": response.contentType });
  if (response.stream && req.method !== "HEAD") {
    void streamBody(res, response.stream);
    return;
  }
  res.end(response.body);
}

/** Start the read-only dashboard on 127.0.0.1; rejects with an actionable message if the port is taken. */
export function startDashboard(options: StartDashboardOptions): Promise<DashboardServer> {
  const server = http.createServer((req, res) => serve(options.source, req, res));
  server.keepAliveTimeout = 1_000;
  return new Promise((resolve, reject) => {
    const onListenError = (error: NodeJS.ErrnoException): void => reject(listenError(error, options.port));
    server.once("error", onListenError);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", onListenError);
      server.on("error", (error) => options.onError?.(error));
      server.unref();
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise<void>((done) => {
            const guard = setTimeout(done, CLOSE_GUARD_MS);
            guard.unref();
            server.closeAllConnections();
            server.close(() => {
              clearTimeout(guard);
              done();
            });
          }),
      });
    });
  });
}
