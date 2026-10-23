import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HordeRunArgs } from "../args.js";
import { formatRunId } from "../format.js";
import { appendRunHeading } from "../ledger/board.js";
import { listFacts } from "../ledger/facts.js";
import { ensureFindingIds } from "../ledger/findings.js";
import { claimIdea, listIdeas, seedPlan } from "../ledger/ideas.js";
import { newMemberState } from "../member.js";
import { VERIFIER_ROLE, memberSystemPrompt, taskMarkdown } from "../prompt.js";
import type { HordeRun } from "./types.js";

function planMarkdown(id: string, layers: string[], count: number): string {
  return [
    `# Plan ${id}`,
    "",
    `${layers.length} workstreams across ${count} members.`,
    "",
    ...layers.map(
      (layer, index) => `- layer ${index + 1} (owner member-${(index % count) + 1}): ${layer}`,
    ),
    "",
  ].join("\n");
}

/** Per-member instruction for a partitioned run. */
function assignRoles(plan: string[], count: number): string[] {
  const roles: string[] = [];
  for (let i = 0; i < count; i++) {
    const owned = plan
      .map((layer, index) => ({ layer, index }))
      .filter((entry) => entry.index % count === i);
    if (owned.length > 0) {
      roles.push(
        `You own workstream ${owned.map((entry) => `${entry.index + 1} "${entry.layer}"`).join(", ")}. ` +
          `Work only on your workstream; do not duplicate another member's.`,
      );
    } else {
      roles.push(VERIFIER_ROLE);
    }
  }
  return roles;
}

/**
 * Roles for an unpartitioned run: the last member verifies the others' findings
 * once there are at least three members, unless `--no-verifier` was given.
 */
function defaultRoles(count: number, noVerifier: boolean): string[] {
  const roles = Array.from({ length: count }, () => "");
  if (count >= 3 && !noVerifier) roles[count - 1] = VERIFIER_ROLE;
  return roles;
}

function allocateRunDir(hordeDir: string, startedAt: number): { id: string; runDir: string } {
  const base = formatRunId(new Date(startedAt));
  for (let attempt = 0; ; attempt++) {
    const id = attempt === 0 ? base : `${base}-${attempt}`;
    const runDir = path.join(hordeDir, "runs", id);
    try {
      fs.mkdirSync(runDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true });
    return { id, runDir };
  }
}

/** Allocate the run directory, write TASK.md and SYSTEM.md, and build the run record. */
export function createRun(
  ctx: ExtensionCommandContext,
  parsed: HordeRunArgs,
  hordeDir: string,
  dashboardUrl: string | undefined,
): { run: HordeRun; roles: string[] } {
  const { count, prompt, plan } = parsed;
  const startedAt = Date.now();
  const { id, runDir } = allocateRunDir(hordeDir, startedAt);
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const roles =
    plan && plan.length > 0
      ? assignRoles(plan, count)
      : defaultRoles(count, parsed.noVerifier === true);
  const verifierIndex = roles.indexOf(VERIFIER_ROLE);
  const verifier = verifierIndex === -1 ? undefined : `member-${verifierIndex + 1}`;
  fs.writeFileSync(
    path.join(runDir, "TASK.md"),
    taskMarkdown({
      id, prompt, count, model, thinkingLevel: ctx.thinkingLevel, startedAt, verifier, untilStop: parsed.untilStop,
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(runDir, "SYSTEM.md"), memberSystemPrompt({ hordeDir, count }), "utf-8");
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  writeManifest(runDir, { model, thinking: ctx.thinkingLevel, roles, prompt });
  const run: HordeRun = {
    id, hordeDir, runDir, prompt, count, startedAt,
    members: Array.from({ length: count }, (_, i) => newMemberState(i + 1)),
    controller: new AbortController(),
    controllers: new Map(),
    procs: new Map(),
    cwd: ctx.cwd,
    startFactId: listFacts(hordeDir).reduce((max, fact) => Math.max(max, fact.id), 0),
    startIdeaId: listIdeas(hordeDir).reduce((max, idea) => Math.max(max, idea.id), 0),
    stopped: false,
    cleanStopNames: [],
    model,
    plan,
    verifier,
    untilStop: parsed.untilStop === true ? true : undefined,
    resets: [],
    dashboardUrl,
  };
  return { run, roles };
}

function writeManifest(runDir: string, settings: Record<string, unknown>): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const code = createHash("sha256");
  const visit = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === "tests") continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) visit(file);
      else if (name.endsWith(".ts")) code.update(path.relative(root, file)).update(fs.readFileSync(file));
    }
  };
  visit(root);
  const config = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^PI_HORDE_(?:REPAIR|REMIND|STALL|RESET|MAX|ALLOW|SOLVED|INBOX|CANARY|DELIVERABLE|POSTMORTEM|CLEANUP)/.test(key)));
  fs.writeFileSync(path.join(runDir, "MANIFEST.json"), JSON.stringify({ protocol: 1, codeHash: code.digest("hex"),
    promptHash: createHash("sha256").update(String(settings.prompt)).digest("hex"),
    systemHash: createHash("sha256").update(fs.readFileSync(path.join(runDir, "SYSTEM.md"))).digest("hex"), settings, config }, null, 2));
}

/** Stamp legacy finding ids, open the run's board section, and seed a partitioned plan. */
export async function seedRun(run: HordeRun): Promise<void> {
  const { hordeDir, id, plan, count } = run;
  // One-time migration: stamp ids onto legacy findings so ids stay stable.
  await ensureFindingIds(hordeDir);
  await appendRunHeading(hordeDir, id, run.prompt);
  if (!plan || plan.length === 0) return;
  fs.writeFileSync(path.join(run.runDir, "PLAN.md"), planMarkdown(id, plan, count), "utf-8");
  const seeded = await seedPlan(hordeDir, plan);
  for (const [index, idea] of seeded.entries()) {
    const owner = `member-${(index % count) + 1}`;
    try {
      await claimIdea(hordeDir, owner, idea.id, { checkOverlap: false });
    } catch {
      // Leave the idea open if the claim fails.
    }
  }
}
