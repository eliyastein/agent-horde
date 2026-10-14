import * as fs from "node:fs";
import * as path from "node:path";
import { clusterFindings } from "./ledger/clusters.js";
import { collaborationState } from "./ledger/collaboration.js";
import { findingReviewState } from "./ledger/findings.js";
import type { FindingEntry } from "./ledger/findings.js";
import { listResources, readRunResources } from "./ledger/resources.js";
import type { ResourceEntry } from "./ledger/resources.js";
import type { HordeRun } from "./run/types.js";

/** Stable run-artifact references which must be registered as a shared resource. */
function artifactReferences(text: string): string[] {
  return [...text.matchAll(/(?:\.tmp\/horde\/[^\s`)'"]+|\.horde\/runs\/[^\s`)'"]+)/g)]
    .map((match) => (match[0] ?? "").replace(/[.,;:]+$/, ""));
}

/** File extensions that make a token a plausible path rather than prose. */
const FILE_EXT =
  /[\w-]+\.(?:tsv|csv|json|jsonl|ndjson|md|txt|log|ya?ml|xml|html?|pdf|png|jpe?g|gif|svg|db|sqlite|pcap|har|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|go|rs|c|h|cc|cpp|java|rb|php|lua|r|jl|pl|toml|ini|cfg|conf|env|lock|zip|tar|gz)$/i;

/**
 * Data-file extensions a member writes and cites by name. A bare filename or a
 * non-rooted path is existence-checked only with one of these, so the target
 * site's source (a `.php`/`.js` path the finding discusses) is not flagged as a
 * missing local artifact. Source artifacts a member does write are cited under a
 * run root and caught by that branch regardless of extension.
 */
const DATA_EXT =
  /\.(?:tsv|csv|json|jsonl|ndjson|md|txt|out|log|ya?ml|xml|har|pcap|db|sqlite|pdf|png|jpe?g|gif|svg)$/i;

/** Path roots that are worth checking even without a file extension. */
const RUN_ROOT = /^(?:\.horde|\.tmp|runs|artifacts)(?:[/-]|$)/;

/** Host-anchored references such as docs.example.com/page are URLs, not local paths. */
const HOST_PATH = /^(?:[a-z0-9-]+\.)+[a-z]{2,}\//i;

/**
 * File paths and bare data-file names cited in prose, for the finalize existence
 * check. Broader than `artifactReferences` (which gates finding citations to the
 * two run roots): this also catches relative paths and bare filenames like
 * `indicators.tsv`, so a cited file that was never written is flagged.
 *
 * Deliberately conservative about what counts as a path. A token qualifies only
 * when it carries a file extension or starts at a known run root. Prose slashes
 * (`AND/OR`, `input/output`, `tokens/second`), ratios (`2/3`), host paths
 * (`docs.example.com/x`), and `owner/repo` slugs are skipped, because they made
 * the warning block mostly false positives.
 */
export function citedDataFiles(text: string): string[] {
  const out = new Set<string>();
  const consider = (raw: string, followedBy = ""): void => {
    // A brace expansion (`member-{1..6}/`) or a shell variable (`$RUN`) is not a
    // literal file to existence-check; the match is a truncated glob prefix.
    if (followedBy.startsWith("{")) return;
    const ref = raw.replace(/[.,;:]+$/, "").replace(/^\.\//, "");
    if (ref === "") return;
    if (ref.startsWith("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return;
    if (/[{}*$]/.test(ref)) return;
    if (HOST_PATH.test(ref)) return;
    const isRooted = RUN_ROOT.test(ref);
    // Under a run root, any extension is a member artifact worth checking. Off a
    // run root, only a data-file extension is; a bare or non-rooted source path is
    // almost always the target's code the finding is about, not a local artifact.
    if (!isRooted && !DATA_EXT.test(ref)) return;
    out.add(ref);
  };
  for (const match of text.matchAll(/`([^`\s]+)`/g)) consider(match[1] ?? "");
  for (const match of text.matchAll(/(?<![\w:/.])(?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+(?:\.[A-Za-z0-9]{1,6})?/g)) {
    consider(match[0] ?? "", text[(match.index ?? 0) + match[0].length] ?? "");
  }
  for (const match of text.matchAll(/(?<![\w/.-])([\w-]+\.[A-Za-z0-9]{1,6})\b/g)) consider(match[1] ?? "");
  return [...out];
}

/** Bounded search for a file by name under a directory; artifact dirs are small. */
function fileNamedUnder(dir: string, name: string, depth = 6): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return true;
    if (entry.isDirectory() && depth > 0 && fileNamedUnder(path.join(dir, entry.name), name, depth - 1)) {
      return true;
    }
  }
  return false;
}

/**
 * True when a cited file cannot be resolved to an existing file on disk. Paths
 * are tried against the repo root, the run directory, its artifacts directory,
 * and the directory of the citing file. Because generated artifacts usually cite
 * retained files by a relative name, a basename match anywhere in this run's tree
 * also counts, which keeps the warning precise instead of noisy.
 */
function citedFileMissing(run: HordeRun, ref: string, baseDir?: string): boolean {
  const roots = [run.cwd, run.runDir, path.join(run.runDir, "artifacts")];
  if (baseDir) roots.push(baseDir);
  const mustBeFile = FILE_EXT.test(ref);
  for (const root of roots) {
    try {
      const stat = fs.statSync(path.resolve(root, ref));
      if (mustBeFile ? stat.isFile() : stat.isFile() || stat.isDirectory()) return false;
    } catch {
      // Try the next root.
    }
  }
  const base = ref.replace(/^\.\//, "").split("/").pop() ?? ref;
  return !fileNamedUnder(run.runDir, base);
}

export function resourceCitations(text: string): number[] {
  // Exclude run ids embedded in paths such as .horde/runs/R1/artifacts/poc.py.
  return [...text.matchAll(/(?<![/A-Za-z0-9_-])R(\d+)\b/g)].map((match) => Number(match[1]));
}

export function validateFindingResourceCitations(
  hordeDir: string,
  runId: string | undefined,
  text: string,
): void {
  if (artifactReferences(text).length === 0) return;
  const cited = resourceCitations(text);
  if (cited.length === 0) {
    const artifacts = runId ? collaborationState(hordeDir, runId).artifacts : [];
    const published = artifacts.filter((a) => new RegExp(`\\b${a.id}\\b`).test(text));
    if (published.length && artifactReferences(text).every((ref) => published.some((a) => ref.endsWith(a.path)))) return;
    throw new Error("horde: a finding that cites a run artifact must cite its registered resource R# or published artifact A# covering that path");
  }
  const known = new Set(listResources(hordeDir).map((resource) => resource.id));
  const missing = cited.find((id) => !known.has(id));
  if (missing !== undefined) throw new Error(`horde: finding cites unknown resource R${missing}`);
  if (runId) {
    const touched = new Set(readRunResources(path.join(hordeDir, "runs", runId)));
    const stale = cited.find((id) => !touched.has(id));
    if (stale !== undefined) throw new Error(`horde: resource R${stale} was not claimed or reused in this run`);
  }
}

export function reportConsistencyWarnings(
  run: HordeRun,
  findings: FindingEntry[],
  clusters: ReturnType<typeof clusterFindings>,
  resources: ResourceEntry[],
): string[] {
  const warnings = new Set<string>();
  const resourceIds = new Set(resources.map((resource) => resource.id));
  for (const finding of findings) {
    if (!finding.concern) warnings.add(`F${finding.id} has no concern metadata; cluster placement is heuristic`);
    if (!finding.support) warnings.add(`F${finding.id} has no support label`);
    const refs = artifactReferences(finding.body);
    const cited = resourceCitations(finding.body);
    if (refs.length > 0 && cited.length === 0) {
      try { validateFindingResourceCitations(run.hordeDir, run.id, finding.body); }
      catch { warnings.add(`F${finding.id} cites an artifact without an R# resource or matching published A#`); }
    }
    for (const ref of refs) {
      // An unexpanded placeholder such as .horde/runs/$RUN/... is a member typo,
      // not a real path; existence-checking it only produces noise.
      if (ref.includes("$")) continue;
      if (!fs.existsSync(path.resolve(run.cwd, ref))) warnings.add(`F${finding.id} artifact path is missing: ${ref}`);
    }
    for (const id of cited) if (!resourceIds.has(id)) warnings.add(`F${finding.id} cites missing resource R${id}`);
  }
  for (const cluster of clusters) {
    const concerns = new Set(cluster.findings.map((finding) => finding.concern).filter(Boolean));
    if (concerns.size > 1) {
      warnings.add(
        `cluster F${cluster.representative.id} mixes concerns: ${[...concerns].join(", ")}`,
      );
    }
  }
  for (const resource of resources) {
    for (const ref of citedDataFiles(resource.note ?? "")) {
      if (citedFileMissing(run, ref, run.hordeDir))
        warnings.add(`resource R${resource.id} cites a path that does not exist: ${ref}`);
    }
  }
  // A verifier that also built or reused the evidence it verified is not fully
  // independent. Flag the overlap so the verify note can disclose it.
  for (const finding of findings) {
    if (!finding.verifiedBy) continue;
    for (const id of resourceCitations(finding.body)) {
      const resource = resources.find((entry) => entry.id === id);
      if (!resource) continue;
      if (resource.owner === finding.verifiedBy || resource.reusers.includes(finding.verifiedBy)) {
        warnings.add(
          `F${finding.id} was verified by ${finding.verifiedBy}, who also owns or reused R${id} "${resource.name}" cited by the finding; disclose the overlap`,
        );
      }
    }
  }
  return [...warnings];
}

/** Flag F#/T# ids that a generated artifact cites but that do not exist in the ledger. */
export function ledgerCitationWarnings(
  label: string,
  text: string,
  findingIds: Set<number>,
  factIds: Set<number>,
): string[] {
  const warnings: string[] = [];
  for (const match of text.matchAll(/\bF(\d+)\b/g)) {
    const id = Number(match[1]);
    if (!findingIds.has(id)) warnings.push(`${label} cites unknown finding F${id}`);
  }
  for (const match of text.matchAll(/\bT(\d+)\b/g)) {
    const id = Number(match[1]);
    if (!factIds.has(id)) warnings.push(`${label} cites unknown fact T${id}`);
  }
  return [...new Set(warnings)];
}

export function generatedArtifactWarnings(
  run: HordeRun,
  label: string,
  text: string,
  resources: ResourceEntry[],
  findings: FindingEntry[] = [],
): string[] {
  const warnings: string[] = [];
  const known = new Set(resources.map((resource) => resource.id));
  for (const id of resourceCitations(text)) {
    if (!known.has(id)) warnings.push(`${label} cites missing resource R${id}`);
  }
  for (const ref of citedDataFiles(text)) {
    if (citedFileMissing(run, ref, run.runDir)) warnings.push(`${label} cites a path that does not exist: ${ref}`);
  }
  // A generated deliverable must not present an unreproduced finding as settled.
  const state = run.hordeDir && run.id ? collaborationState(run.hordeDir, run.id) : { reviews: [], messages: [] };
  const checks = findings.map((f) => ({ ...f, check: findingReviewState(f, state.reviews, state.messages) }));
  const unverified = checks.filter((f) => f.check.status === "unreviewed");
  for (const status of ["limited", "disputed"]) {
    const cited = checks.filter((f) => f.check.status === status && new RegExp(`\\bF${f.id}\\b`).test(text));
    if (cited.length) warnings.push(`${label} cites ${status === "limited" ? "scope-limited reviews" : "disputed findings"} (${cited.map((f) => `F${f.id}`).join(", ")}); consult the exact checked/unchecked scope and unresolved challenges in COLLABORATION.md`);
  }
  const citedUnverified = unverified.filter((finding) =>
    new RegExp(`\\bF${finding.id}\\b`).test(text),
  );
  if (citedUnverified.length > 0 && !/unverified/i.test(text)) {
    warnings.push(
      `${label} cites unverified findings (${citedUnverified.map((finding) => `F${finding.id}`).join(", ")}) ` +
        "without labeling them unverified",
    );
  }
  return [...new Set(warnings)];
}
