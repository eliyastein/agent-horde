import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** What is running: the package version and, from a git checkout, the commit it is at. */
export interface BuildInfo {
  name: string;
  version: string;
  /** Short hash of HEAD, suffixed `-dirty` when the tree has uncommitted changes; absent outside a checkout. */
  commit?: string | undefined;
  /** The project's web repository, for linking the commit. */
  repository?: string | undefined;
}

const GIT_TIMEOUT_MS = 2_000;

/** The package directory: the parent of `src/`, which is also where `package.json` lives. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function repositoryUrl(raw: unknown): string | undefined {
  const url = typeof raw === "string" ? raw : typeof raw === "object" && raw !== null ? (raw as { url?: unknown }).url : undefined;
  if (typeof url !== "string") return undefined;
  const web = url.replace(/^git\+/, "").replace(/\.git$/, "");
  return web.startsWith("https://") ? web : undefined;
}

/** The commit of the checkout rooted at `root`, or undefined when `root` is not itself a checkout (no parent repo is consulted). */
function describeCommit(root: string): string | undefined {
  if (!fs.existsSync(path.join(root, ".git"))) return undefined;
  try {
    const out = execFileSync("git", ["describe", "--always", "--dirty", "--exclude=*", "--abbrev=7"], {
      cwd: root,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{7,40}(?:-dirty)?$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the package at `root`; throws when its package.json is missing or malformed. */
export function readBuildInfo(root: string): BuildInfo {
  const file = path.join(root, "package.json");
  let pkg: { name?: unknown; version?: unknown; repository?: unknown };
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8")) as typeof pkg;
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}; reinstall agent-horde`);
  }
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") throw new Error(`${file} has no name or version; reinstall agent-horde`);
  return { name: pkg.name, version: pkg.version, commit: describeCommit(root), repository: repositoryUrl(pkg.repository) };
}

let cached: BuildInfo | undefined;

/** The running package's build, read once per process. */
export function buildInfo(): BuildInfo {
  cached ??= readBuildInfo(packageRoot());
  return cached;
}
