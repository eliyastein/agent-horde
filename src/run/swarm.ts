import * as fs from "node:fs";
import * as path from "node:path";
import { formatDateTime, formatRunId, taskHash } from "../format.js";
import { hordePaths, initHordeDirAt } from "../ledger/files.js";
import type { SiblingHorde } from "../member.js";
import { hordeLabel } from "./types.js";
import type { Swarm } from "./types.js";

/** Where a swarm's ids and directories landed. */
export interface SwarmLayout {
  id: string;
  /** `.horde/swarms/<id>`; undefined for a swarm of one. */
  dir: string | undefined;
  /** One complete horde directory per horde, `h1` first. */
  hordeDirs: string[];
  /** Run ids, `h1` first: the swarm id alone for a swarm of one, else `<id>-h<N>`. */
  runIds: string[];
  /** `<hordeDir>/runs/<runId>`, created and empty but for `sessions/`. */
  runDirs: string[];
}

/** Make `<parent>/<base>` or the first free `<base>-<n>`, exclusively, and return its name. */
function allocateUnique(parent: string, base: string): string {
  for (let attempt = 0; ; attempt++) {
    const name = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      fs.mkdirSync(path.join(parent, name));
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function makeRunDir(hordeDir: string, runId: string): string {
  const runDir = path.join(hordePaths(hordeDir).runs, runId);
  fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true });
  return runDir;
}

/** The swarm directories hold whole horde directories, so they are run output, not ledgers. */
function ignoreSwarms(hordeDir: string): void {
  const gitignore = hordePaths(hordeDir).gitignore;
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf-8") : "";
  if (existing.split("\n").some((line) => line.trim() === "swarms/")) return;
  fs.writeFileSync(gitignore, `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}swarms/\n`, "utf-8");
}

/**
 * Allocate the swarm's id and directories. A swarm of one keeps the plain time-based run id
 * under `.horde/runs/`, so single runs share the project ledgers as before; a larger swarm gets
 * `.horde/swarms/<id>/h<N>/`, each a complete horde directory with its own ledgers and lock.
 */
export function allocateSwarm(hordeDir: string, hordes: number, startedAt: number): SwarmLayout {
  const base = formatRunId(new Date(startedAt));
  if (hordes === 1) {
    const id = allocateUnique(hordePaths(hordeDir).runs, base);
    const runDir = path.join(hordePaths(hordeDir).runs, id);
    fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true });
    return { id, dir: undefined, hordeDirs: [hordeDir], runIds: [id], runDirs: [runDir] };
  }
  const swarms = path.join(hordeDir, "swarms");
  fs.mkdirSync(swarms, { recursive: true });
  ignoreSwarms(hordeDir);
  const id = allocateUnique(swarms, base);
  const dir = path.join(swarms, id);
  const layout: SwarmLayout = { id, dir, hordeDirs: [], runIds: [], runDirs: [] };
  for (let horde = 1; horde <= hordes; horde++) {
    const hordeDirN = initHordeDirAt(path.join(dir, hordeLabel(horde)));
    const runId = `${id}-${hordeLabel(horde)}`;
    layout.hordeDirs.push(hordeDirN);
    layout.runIds.push(runId);
    layout.runDirs.push(makeRunDir(hordeDirN, runId));
  }
  return layout;
}

/** Deal `plan` layers to `hordes` hordes round-robin: layer 1 to h1, layer 2 to h2, and so on. */
export function dealLayers(plan: string[], hordes: number): string[][] {
  const dealt: string[][] = Array.from({ length: hordes }, () => []);
  plan.forEach((layer, index) => dealt[index % hordes]!.push(layer));
  return dealt;
}

/** The horde directories a member may read besides its own, with each horde's workstream. */
export function siblingHordes(layout: SwarmLayout, partition: string[] | undefined, horde: number): SiblingHorde[] {
  return layout.hordeDirs
    .map((hordeDir, index) => ({ label: hordeLabel(index + 1), hordeDir, slice: partition?.[index] }))
    .filter((_sibling, index) => index + 1 !== horde);
}

/** SWARM.md: the prompt, the partition, and where each horde works. */
export function swarmMarkdown(swarm: Swarm): string {
  const partition = swarm.partition ?? [];
  return [
    `# Swarm ${swarm.id}`,
    "",
    `Started: ${formatDateTime(new Date(swarm.startedAt))}`,
    `Hordes: ${swarm.hordes} x ${swarm.count} members (${hordeLabel(1)} .. ${hordeLabel(swarm.hordes)})`,
    `Model: ${swarm.runs[0]?.model ?? "parent default"}`,
    `Until stop: ${swarm.untilStop ? "yes (every horde continues until stop-clean or stop-hard)" : "no"}`,
    `Partition: ${swarm.plan ? "plan layers dealt round-robin" : "planner helper"}`,
    `Task-SHA256: ${taskHash(swarm.prompt)}`,
    "",
    "## Prompt",
    "",
    swarm.prompt,
    "",
    "## Partition",
    "",
    ...partition.map((slice, index) => `- ${hordeLabel(index + 1)}: ${slice}`),
    "",
    "## Hordes",
    "",
    ...swarm.runs.map((run) => `- ${hordeLabel(run.horde)}: ${run.runDir}`),
    "",
  ].join("\n");
}

/** A planner slice as the members read it: the workstream, then its acceptance criterion. */
export function sliceText(workstream: string, acceptance: string | undefined): string {
  const trimmed = workstream.trim();
  const criterion = acceptance?.trim();
  return criterion ? `${trimmed} Acceptance: ${criterion}` : trimmed;
}

/**
 * The planner's output as H distinct workstreams, or why it is unusable. The helper is told to
 * print only a JSON array; anything around it is tolerated, a wrong count or a repeat is not.
 */
export function parsePlannerOutput(output: string, hordes: number): { slices: string[] } | { error: string } {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end <= start) return { error: "the planner printed no JSON array" };
  let items: unknown;
  try {
    items = JSON.parse(output.slice(start, end + 1));
  } catch (error) {
    return { error: `the planner's JSON did not parse (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!Array.isArray(items)) return { error: "the planner printed something other than an array" };
  if (items.length !== hordes) return { error: `the planner produced ${items.length} workstream(s), not ${hordes}` };
  const slices: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const record = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const workstream = typeof record.workstream === "string" ? record.workstream : typeof item === "string" ? item : "";
    const acceptance = typeof record.acceptance === "string" ? record.acceptance : undefined;
    const key = workstream.trim().toLowerCase().replace(/\s+/g, " ");
    if (key === "") return { error: "the planner produced an empty workstream" };
    if (seen.has(key)) return { error: `the planner repeated a workstream: ${workstream.trim()}` };
    seen.add(key);
    slices.push(sliceText(workstream, acceptance));
  }
  return { slices };
}
