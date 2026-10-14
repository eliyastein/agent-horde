import * as fs from "node:fs";
import * as path from "node:path";
import { formatClock } from "../format.js";

interface HordePaths {
  dir: string;
  ideas: string;
  board: string;
  findings: string;
  facts: string;
  claims: string;
  resources: string;
  concerns: string;
  lock: string;
  runs: string;
  gitignore: string;
}

const IDEAS_HEADER = [
  "# Ideas",
  "",
  "Marks: [ ] open, [~] in progress, [x] done, [!] ruled out (dead end). Only the horde tool writes here.",
  "",
].join("\n");

const BOARD_HEADER = "# Board\n";

const FINDINGS_HEADER = "# Findings\n";

const FACTS_HEADER = [
  "# Facts",
  "",
  "Low-controversy, checkable environment facts. Read this before re-deriving.",
  "",
].join("\n");

const CLAIMS_HEADER = [
  "# Claims",
  "",
  "Reconciled hypotheses. States: open, confirmed, contested, retracted, superseded, unverified.",
  "",
].join("\n");

const RESOURCES_HEADER = [
  "# Resources",
  "",
  "Shared artifacts: datasets, harnesses, corpora, labs, and sandboxes. Claim one with the horde",
  "tool before building it; if it is already claimed, reuse the owner's version instead of",
  "rebuilding.",
  "",
].join("\n");

const CONCERNS_HEADER = [
  "# Concerns",
  "",
  "One line per concern slug: root cause plus entry point. Reuse a slug that names the same",
  "pair; add a new one only with a definition.",
  "",
].join("\n");

export function hordePaths(hordeDir: string): HordePaths {
  return {
    dir: hordeDir,
    ideas: path.join(hordeDir, "IDEAS.md"),
    board: path.join(hordeDir, "BOARD.md"),
    findings: path.join(hordeDir, "FINDINGS.md"),
    facts: path.join(hordeDir, "FACTS.md"),
    claims: path.join(hordeDir, "CLAIMS.md"),
    resources: path.join(hordeDir, "RESOURCES.md"),
    concerns: path.join(hordeDir, "CONCERNS.md"),
    lock: path.join(hordeDir, ".lock"),
    runs: path.join(hordeDir, "runs"),
    gitignore: path.join(hordeDir, ".gitignore"),
  };
}

function writeIfMissing(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, "utf-8");
}

export function initHordeDir(cwd: string): string {
  const paths = hordePaths(path.join(cwd, ".horde"));
  fs.mkdirSync(paths.runs, { recursive: true });
  writeIfMissing(paths.gitignore, "runs/\n");
  writeIfMissing(paths.ideas, IDEAS_HEADER);
  writeIfMissing(paths.board, BOARD_HEADER);
  writeIfMissing(paths.findings, FINDINGS_HEADER);
  writeIfMissing(paths.facts, FACTS_HEADER);
  writeIfMissing(paths.claims, CLAIMS_HEADER);
  writeIfMissing(paths.resources, RESOURCES_HEADER);
  writeIfMissing(paths.concerns, CONCERNS_HEADER);
  return paths.dir;
}

export function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

export function requireText(text: string | undefined, action: string): string {
  const collapsed = (text ?? "").trim();
  if (collapsed === "") throw new Error(`horde: text is required for action '${action}'`);
  return collapsed;
}

/** A required non-text parameter: names the missing field, not just the action. */
export function requireParam(value: string | undefined, field: string, action: string): string {
  const collapsed = (value ?? "").trim();
  if (collapsed === "") throw new Error(`horde: ${field} is required for action '${action}'`);
  return collapsed;
}

export function neutralizeHeadings(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^#{1,6}(\s|$)/.test(line) ? `\\${line}` : line))
    .join("\n");
}

export function boardEntry(author: string, text: string, now: Date = new Date()): string {
  return `\n### ${formatClock(now)} ${author}\n${neutralizeHeadings(text.trim())}\n`;
}

export function appendEntry(filePath: string, entry: string): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileAtomic(filePath, `${existing}${separator}${entry}`);
}

export function readHordeFile(hordeDir: string, file: "ideas" | "board" | "findings"): string {
  return fs.readFileSync(hordePaths(hordeDir)[file], "utf-8");
}
