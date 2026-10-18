import * as fs from "node:fs";
import * as path from "node:path";
import { oneLine } from "../format.js";
import { appendEntry, hordePaths, requireText, writeFileAtomic } from "./files.js";
import { withHordeLock } from "./lock.js";
import { dedupAnchors } from "./text-match.js";

/** A shared artifact a member registered so others reuse it instead of rebuilding. */
export interface ResourceEntry {
  id: number;
  name: string;
  owner: string;
  /** Member names are reused across runs; ownership includes the originating run. */
  ownerRunId?: string;
  note?: string | undefined;
  /** Members that claimed an existing resource instead of creating a new one. */
  reusers: string[];
  /** Shell command the parent runs at finalize to tear the artifact down. */
  cleanup?: string | undefined;
}

const RESOURCE_LINE =
  /^- \[R(\d+)\] (.+?)(?:\s{2}@(\S+?))?(?:: (.*?))?(?:\s{2}reuse=(\S+))?(?:\s{2}cleanup: (.*))?$/;

function parseResources(content: string): ResourceEntry[] {
  const resources: ResourceEntry[] = [];
  for (const line of content.split("\n")) {
    const origin = /  origin=([\w-]+)$/.exec(line);
    const match = RESOURCE_LINE.exec(origin ? line.slice(0, origin.index) : line);
    if (!match) continue;
    resources.push({
      id: Number(match[1]),
      name: match[2] ?? "",
      owner: match[3] ?? "",
      ...(origin ? { ownerRunId: origin[1] } : {}),
      note: match[4] || undefined,
      reusers: match[5] ? match[5].split(",").map((name) => name.trim()).filter(Boolean) : [],
      cleanup: match[6] || undefined,
    });
  }
  return resources;
}

function formatResource(resource: ResourceEntry): string {
  let line = `- [R${resource.id}] ${resource.name}`;
  if (resource.owner) line += `  @${resource.owner}`;
  if (resource.note) line += `: ${resource.note}`;
  if (resource.reusers.length > 0) line += `  reuse=${resource.reusers.join(",")}`;
  if (resource.cleanup) line += `  cleanup: ${resource.cleanup}`;
  if (resource.ownerRunId) line += `  origin=${resource.ownerRunId}`;
  return line;
}

export function listResources(hordeDir: string): ResourceEntry[] {
  const file = hordePaths(hordeDir).resources;
  if (!fs.existsSync(file)) return [];
  return parseResources(fs.readFileSync(file, "utf-8"));
}

/** Preserve the original description before an authorized mutation, under the resource lock. */
function archiveResourceUpdate(hordeDir: string, previous: ResourceEntry, replacement: ResourceEntry, runId?: string): void {
  const fd = fs.openSync(path.join(hordeDir, "resource-history.jsonl"), "a");
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ at: new Date().toISOString(), runId, action: "update-intent", previous, replacement })}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Infrastructure words that do not by themselves mark two resources as the same. */
const RESOURCE_GENERIC_TOKENS = new Set([
  "docker",
  "dotnet",
  "python",
  "node",
  "linux",
  "bash",
  "shell",
  "local",
  "basic",
  "probe",
  "harness",
  "script",
  "static",
  "cracker",
  "crackers", "pinned", "source", "checkout", "clone", "shared", "lab", "environment", "env", "toolchain",
]);

/** Tokens for resource names, splitting version runs so `php8.2` and `php 8.2` agree. */
function resourceTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/([a-z])(\d)/g, "$1 $2")
      .replace(/(\d)([a-z])/g, "$1 $2")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter((token) => token.length > 0),
  );
}

/** Match equivalent resource identities and versions, ignoring only generic infrastructure words. */
function resourceNamesMatch(a: string, b: string): boolean {
  const left = resourceTokens(a);
  const right = resourceTokens(b);
  const numerics = (tokens: Set<string>): string[] => [...tokens].filter((t) => /^\d+$/.test(t));
  const leftNumbers = numerics(left);
  const rightNumbers = numerics(right);
  if (leftNumbers.length !== rightNumbers.length || !leftNumbers.every((n) => right.has(n))) return false;
  const identity = (tokens: Set<string>) => [...tokens].filter((t) => !/^\d+$/.test(t) && !RESOURCE_GENERIC_TOKENS.has(t));
  const aIdentity = identity(left);
  const bIdentity = identity(right);
  return aIdentity.length > 0 && aIdentity.length === bIdentity.length && aIdentity.every((t) => bIdentity.includes(t));
}

/** Preserve hash-backed aliases. A shared website or numeric ID is not resource identity. */
function notesShareAnchor(a: ResourceEntry, b: string): boolean {
  const target = dedupAnchors(b);
  if (target.size === 0) return false;
  const anchors = dedupAnchors(`${a.name} ${a.note ?? ""}`);
  return [...target].some((key) => /^[a-f0-9]{12,}$/i.test(key) && anchors.has(key));
}

function bestResourceMatch(resources: ResourceEntry[], name: string, note?: string): ResourceEntry | undefined {
  const combined = `${name} ${note ?? ""}`;
  return resources.find((resource) => notesShareAnchor(resource, combined)) ??
    resources.find((resource) => resourceNamesMatch(resource.name, name));
}

interface ClaimResourceResult {
  resource: ResourceEntry;
  /** An existing resource was returned instead of a new one being created. */
  reused: boolean;
  /** The caller already owned it. */
  ownedByCaller: boolean;
}

/**
 * Cleanup is for external runtime objects such as containers and processes.
 * Reproducer files are evidence and stay under the run directory.
 */
function cleanupCommandProblem(command: string, runId?: string): string | undefined {
  const normalized = command.trim();
  if (!normalized) return undefined;
  if (runId) {
    const protectedPaths = [`.tmp/horde/${runId}`, `.horde/runs/${runId}`];
    if (protectedPaths.some((value) => normalized.includes(value))) {
      return "cleanup cannot target this run's evidence or artifact directory";
    }
  }
  const containerCleanup =
    /^\s*(?:docker|podman)\b/i.test(normalized) && !/[;&|`$()]/.test(normalized);
  if (
    (!containerCleanup && /\b(?:rm|trash|unlink|rmdir)\b/i.test(normalized)) ||
    /\bfind\b[^;&|]*\s-delete\b/i.test(normalized)
  ) {
    return "filesystem deletion is not allowed in resource cleanup; preserve reproducers as run artifacts";
  }
  return undefined;
}

/** The runtime object a cleanup removes, so two labs that share one container name collide. */
function cleanupObject(command: string): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  const container = /^(?:docker|podman)\s+(?:container\s+|image\s+)?(?:rm|rmi|stop|kill)\b(?:\s+-\S+)*\s+(\S+)/i.exec(normalized);
  if (container) return `object:${container[1]}`;
  const proc = /^pkill\b(?:\s+-\S+)*\s+(.+)$/i.exec(normalized);
  if (proc) return `process:${proc[1]}`;
  return `command:${normalized}`;
}

/** One teardown must not remove two labs: refuse a cleanup another resource of this run registered. */
function cleanupCollision(resources: ResourceEntry[], touched: Set<number>, command: string, selfId?: number): ResourceEntry | undefined {
  if (!command) return undefined;
  const object = cleanupObject(command);
  return resources.find((r) => r.id !== selfId && touched.has(r.id) && r.cleanup !== undefined && cleanupObject(r.cleanup) === object);
}

function collisionMessage(command: string, other: ResourceEntry): string {
  return `horde: cleanup \`${command}\` is already registered by R${other.id} "${other.name}"; reuse R${other.id} or pick a distinct container name`;
}

// Filesystem paths cited in a resource note, used to detect overlapping scopes.
// A URL, a bare filename, or a docker image ref (no slash, or a scheme) is ignored.
function resourceNotePaths(note: string): string[] {
  const out: string[] = [];
  for (const match of note.matchAll(/(?<![\w:/.])(?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+\/?/g)) {
    const raw = match[0].replace(/\/+$/, "").replace(/^\.\//, "");
    if (raw.includes("/") && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) out.push(raw);
  }
  return out;
}

/** True when `a` and `b` name the same path or one is a directory ancestor of the other. */
function pathsOverlap(a: string, b: string): boolean {
  const sa = a.split("/").filter(Boolean);
  const sb = b.split("/").filter(Boolean);
  const [shorter, longer] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  return shorter.length > 0 && shorter.every((seg, i) => seg === longer[i]);
}

/** Refuse a new resource whose cited path nests with an existing one's; name the R# to reuse. */
function overlappingResource(resources: ResourceEntry[], note: string): { id: number; a: string; b: string } | undefined {
  const newPaths = resourceNotePaths(note);
  if (newPaths.length === 0) return undefined;
  for (const resource of resources) {
    for (const existing of resourceNotePaths(resource.note ?? "")) {
      for (const candidate of newPaths) {
        if (pathsOverlap(candidate, existing)) return { id: resource.id, a: candidate, b: existing };
      }
    }
  }
  return undefined;
}

/**
 * Claim a named resource. The first claim owns it; a later claim from another
 * member records them as a reuser and returns the existing entry, so the tool
 * can tell them to reuse it instead of building a second one.
 */
interface ClaimResourceInput {
  name: string | undefined;
  /** Short pointer (path, command, or fact id) others should reuse. */
  note?: string | undefined;
  /** Shell command the parent runs at finalize to tear the resource down. */
  cleanup?: string | undefined;
  runId?: string | undefined;
}

export async function claimResource(
  hordeDir: string,
  owner: string,
  { name, note, cleanup, runId }: ClaimResourceInput,
): Promise<ClaimResourceResult> {
  const resourceName = oneLine(requireText(name, "resource"), 200);
  const noteText = oneLine(note ?? "", 300);
  const cleanupText = oneLine(cleanup ?? "", 400);
  const cleanupProblem = cleanupCommandProblem(cleanupText, runId);
  if (cleanupProblem) throw new Error(`horde: unsafe cleanup: ${cleanupProblem}`);
  return withHordeLock(hordeDir, owner, () => {
    const file = hordePaths(hordeDir).resources;
    const content = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    const resources = parseResources(content);
    const touch = (resourceId: number): void => {
      if (runId) recordRunResource(hordeDir, runId, resourceId);
    };
    const touched = new Set(runId ? readRunResources(path.join(hordeDir, "runs", runId)) : []);
    const collide = (selfId?: number): void => {
      const other = cleanupCollision(resources, touched, cleanupText, selfId);
      if (other) throw new Error(collisionMessage(cleanupText, other));
    };
    const normalized = resourceName.toLowerCase();
    let existing = resources.find((resource) => resource.name.toLowerCase() === normalized);
    if (!existing) existing = bestResourceMatch(resources, resourceName, noteText);
    if (existing) {
      const lines = content.split("\n");
      const lineIndex = lines.findIndex((line) => Number(/^- \[R(\d+)\]/.exec(line)?.[1]) === existing?.id);
      if (existing.owner === owner && existing.name.toLowerCase() === normalized &&
          (!runId || existing.ownerRunId === runId)) {
        if ((noteText && noteText !== existing.note) || (cleanupText && cleanupText !== existing.cleanup)) {
          if (cleanupText && cleanupText !== existing.cleanup) collide(existing.id);
          const updated: ResourceEntry = {
            ...existing,
            note: noteText || existing.note,
            cleanup: cleanupText || existing.cleanup,
          };
          archiveResourceUpdate(hordeDir, existing, updated, runId);
          if (lineIndex >= 0) lines[lineIndex] = formatResource(updated);
          writeFileAtomic(file, lines.join("\n"));
          touch(updated.id);
          return { resource: updated, reused: false, ownedByCaller: true };
        }
        touch(existing.id);
        return { resource: existing, reused: false, ownedByCaller: true };
      }
      // A reuser may supply a missing teardown command, but cannot overwrite the owner's.
      const adoptCleanup = cleanupText && !existing.cleanup;
      if (adoptCleanup) collide(existing.id);
      if (!existing.reusers.includes(owner) || adoptCleanup) {
        const updated: ResourceEntry = {
          ...existing,
          reusers: existing.reusers.includes(owner) ? existing.reusers : [...existing.reusers, owner],
          cleanup: existing.cleanup ?? (cleanupText || undefined),
        };
        if (lineIndex >= 0) lines[lineIndex] = formatResource(updated);
        writeFileAtomic(file, lines.join("\n"));
        touch(updated.id);
        return { resource: updated, reused: true, ownedByCaller: false };
      }
      touch(existing.id);
      return { resource: existing, reused: true, ownedByCaller: false };
    }
    // A resource must not claim a scope that nests with an existing one (for example
    // the whole artifacts/ directory when another resource already owns a file under
    // it); reuse the existing R# and cite it instead of collecting the data twice.
    const overlap = overlappingResource(resources, noteText);
    if (overlap) {
      throw new Error(
        `horde: resource path "${overlap.a}" overlaps R${overlap.id} ("${overlap.b}"); ` +
          `reuse R${overlap.id} and cite it, or claim a disjoint path`,
      );
    }
    collide();
    const id = resources.reduce((max, resource) => Math.max(max, resource.id), 0) + 1;
    const resource: ResourceEntry = {
      id,
      name: resourceName,
      owner,
      ...(runId ? { ownerRunId: runId } : {}),
      note: noteText || undefined,
      reusers: [],
      cleanup: cleanupText || undefined,
    };
    appendEntry(file, `\n${formatResource(resource)}\n`);
    touch(resource.id);
    return { resource, reused: false, ownedByCaller: false };
  });
}

/** Resource ids a run touched, so finalize only tears down this run's artifacts. */
function runResourcesPath(runDir: string): string {
  return path.join(runDir, ".resources");
}

export function readRunResources(runDir: string): number[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(runResourcesPath(runDir), "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === "number") : [];
  } catch {
    return [];
  }
}

/** Record that a run used a resource, so its cleanup command is run at finalize. */
export function recordRunResource(hordeDir: string, runId: string, resourceId: number): void {
  const runDir = path.join(hordeDir, "runs", runId);
  if (!fs.existsSync(runDir)) return;
  const ids = new Set(readRunResources(runDir));
  if (ids.has(resourceId)) return;
  ids.add(resourceId);
  writeFileAtomic(runResourcesPath(runDir), `${JSON.stringify([...ids])}\n`);
}

export interface PendingCleanup {
  id: number;
  name: string;
  owner: string;
  command: string;
  /** Existing hand-edited/legacy cleanup that must not execute. */
  blockedReason?: string | undefined;
}

/** Cleanup commands for the resources this run touched that registered one. */
export function pendingCleanups(hordeDir: string, runId: string): PendingCleanup[] {
  const ids = new Set(readRunResources(path.join(hordeDir, "runs", runId)));
  return listResources(hordeDir)
    .filter((resource) => ids.has(resource.id) && resource.cleanup)
    .map((resource) => ({
      id: resource.id,
      name: resource.name,
      owner: resource.owner,
      command: resource.cleanup!,
      blockedReason: cleanupCommandProblem(resource.cleanup!, runId),
    }));
}
