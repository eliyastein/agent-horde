import * as path from "node:path";
import * as zlib from "node:zlib";

/** One rendered page; `text` pages (the Mermaid export) carry no links to rewrite. */
export interface ExportPage {
  body: string;
  text?: boolean | undefined;
}

/** Renders the dashboard page at a URL; must return an error page rather than throw. */
export type ExportRenderer = (url: URL) => ExportPage;

export interface ZipEntry {
  path: string;
  data: Buffer;
}

const BASE = "http://127.0.0.1";
const MAX_PAGES = 100_000;
const ZIP_MAX_ENTRIES = 0xffff;
const ZIP_MAX_BYTES = 0xffff_ffff;

/** One name component: no separators, and never a dot-only segment, so the zip cannot escape its folder. */
function safeName(text: string): string {
  const safe = text.replace(/[^A-Za-z0-9._=~-]/g, "_");
  return /^\.+$/.test(safe) ? safe.replace(/\./g, "_") : safe;
}

/** The file a dashboard URL becomes: `/` is index.html, query parameters are sorted into the name. */
export function exportFile(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => safeName(decodeURIComponent(segment)));
  const stem = segments.length === 0 ? "index" : segments.join("/");
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => safeName(`${k}=${v}`));
  const name = `${stem}${params.map((pair) => `~${pair}`).join("")}`;
  return url.pathname.endsWith(".mmd") ? name : `${name}.html`;
}

function canonical(href: string): URL {
  const url = new URL(href, BASE);
  url.hash = "";
  const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [k, v] of sorted) url.searchParams.append(k, v);
  return url;
}

function unescapeHtml(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Rewrites every dashboard-absolute href in a page to a path relative to the page's own file. */
function rewriteLinks(body: string, file: string, visit: (url: URL) => string): string {
  const dir = path.posix.dirname(file);
  return body.replace(/href="([^"]*)"/g, (match, raw: string) => {
    const href = unescapeHtml(raw);
    if (!href.startsWith("/")) return match;
    const hashAt = href.indexOf("#");
    const hash = hashAt >= 0 ? href.slice(hashAt) : "";
    const target = visit(canonical(hashAt >= 0 ? href.slice(0, hashAt) : href));
    return `href="${escapeHtml(path.posix.relative(dir, target) + hash)}"`;
  });
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Renders every page reachable from `/`, as files whose links point at each other, one page per event-loop turn. */
export async function* crawlDashboard(render: ExportRenderer): AsyncGenerator<ZipEntry> {
  const files = new Map<string, string>();
  const queue: URL[] = [];
  const visit = (url: URL): string => {
    const key = url.pathname + url.search;
    const known = files.get(key);
    if (known !== undefined) return known;
    if (files.size >= MAX_PAGES) throw new Error(`dashboard export exceeds ${MAX_PAGES} pages`);
    const file = exportFile(url);
    files.set(key, file);
    queue.push(url);
    return file;
  };
  visit(new URL("/", BASE));
  for (let i = 0; i < queue.length; i++) {
    const url = queue[i] as URL;
    const file = files.get(url.pathname + url.search) as string;
    const page = render(url);
    const body = page.text ? page.body : rewriteLinks(page.body, file, visit);
    yield { path: file, data: Buffer.from(body, "utf8") };
    await yieldToLoop();
  }
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

interface ZipRecord {
  name: Buffer;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

function zipHeader(signature: number, record: ZipRecord, stamp: { time: number; date: number }): Buffer {
  const header = Buffer.alloc(26);
  header.writeUInt16LE(20, 0);
  header.writeUInt16LE(0x0800, 2);
  header.writeUInt16LE(record.method, 4);
  header.writeUInt16LE(stamp.time, 6);
  header.writeUInt16LE(stamp.date, 8);
  header.writeUInt32LE(record.crc, 10);
  header.writeUInt32LE(record.compressedSize, 14);
  header.writeUInt32LE(record.size, 18);
  header.writeUInt16LE(record.name.length, 22);
  header.writeUInt16LE(0, 24);
  const sig = Buffer.alloc(4);
  sig.writeUInt32LE(signature, 0);
  return Buffer.concat([sig, header]);
}

function centralEntry(record: ZipRecord, stamp: { time: number; date: number }): Buffer {
  const madeBy = Buffer.alloc(2);
  madeBy.writeUInt16LE(20, 0);
  const tail = Buffer.alloc(14);
  tail.writeUInt16LE(0, 0);
  tail.writeUInt16LE(0, 2);
  tail.writeUInt16LE(0, 4);
  tail.writeUInt32LE(0, 6);
  tail.writeUInt32LE(record.offset, 10);
  const header = zipHeader(0x02014b50, record, stamp);
  return Buffer.concat([header.subarray(0, 4), madeBy, header.subarray(4), tail, record.name]);
}

/** A zip archive streamed one entry at a time: deflated where smaller, UTF-8 names, the given modification time. */
export async function* zipArchive(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>, mtime = new Date()): AsyncGenerator<Buffer> {
  const stamp = dosDateTime(mtime);
  const records: ZipRecord[] = [];
  let offset = 0;
  for await (const entry of entries) {
    if (records.length >= ZIP_MAX_ENTRIES) throw new Error(`dashboard export exceeds ${ZIP_MAX_ENTRIES} files; zip64 is not supported`);
    const deflated = zlib.deflateRawSync(entry.data);
    const compressed = deflated.length < entry.data.length ? deflated : entry.data;
    const record: ZipRecord = {
      name: Buffer.from(entry.path, "utf8"),
      method: compressed === deflated ? 8 : 0,
      crc: zlib.crc32(entry.data),
      compressedSize: compressed.length,
      size: entry.data.length,
      offset,
    };
    const local = Buffer.concat([zipHeader(0x04034b50, record, stamp), record.name, compressed]);
    records.push(record);
    offset += local.length;
    if (offset > ZIP_MAX_BYTES) throw new Error("dashboard export exceeds 4 GiB; zip64 is not supported");
    yield local;
  }
  const central = Buffer.concat(records.map((record) => centralEntry(record, stamp)));
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  yield Buffer.concat([central, end]);
}

async function* underFolder(entries: AsyncIterable<ZipEntry>, folder: string): AsyncGenerator<ZipEntry> {
  for await (const entry of entries) yield { ...entry, path: `${folder}/${entry.path}` };
}

/** Crawls the dashboard into a zip, streamed as it is built, whose top-level folder holds index.html. */
export function exportDashboard(render: ExportRenderer, folder: string, now = new Date()): AsyncGenerator<Buffer> {
  return zipArchive(underFolder(crawlDashboard(render), folder), now);
}

/** The whole stream in one buffer, for callers that want the finished archive. */
export async function collect(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}
