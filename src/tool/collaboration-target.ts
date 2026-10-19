import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { findingRevision, listFindingsForRun } from "../ledger/findings.js";
import { listIdeas } from "../ledger/ideas.js";
import { listResources } from "../ledger/resources.js";
import { readSolvedState } from "../ledger/run-signals.js";
import type { CollaborationState } from "../ledger/collaboration.js";
import type { EventContext } from "../ledger/events.js";

export function hashText(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Follow explicit correction links without transferring reviews to the replacement. */
export function currentTarget(ctx: EventContext, target: string): string {
  const findings = listFindingsForRun(ctx.hordeDir, ctx.runId);
  const seen = new Set<string>();
  while (/^F\d+$/.test(target)) {
    if (seen.has(target)) throw new Error("horde: cyclic finding supersession");
    seen.add(target);
    const finding = findings.find((f) => `F${f.id}` === target);
    if (finding?.supersededBy === undefined) break;
    target = `F${finding.supersededBy}`;
  }
  return target;
}

export function targetInfo(ctx: EventContext, state: CollaborationState, target: string): { owner: string; revision: string } {
  if (target === "answer") {
    const proposal = readSolvedState(path.join(ctx.hordeDir, "runs", ctx.runId)).proposal;
    if (proposal) return { owner: proposal.member, revision: proposal.revision ?? hashText(proposal.text) };
  }
  if (/^A\d+$/.test(target)) {
    const a = state.artifacts.find((entry) => entry.id === target);
    if (a) return { owner: a.owner, revision: a.hash };
  }
  if (/^F\d+$/.test(target)) {
    const f = listFindingsForRun(ctx.hordeDir, ctx.runId).find((entry) => entry.id === Number(target.slice(1)));
    if (f?.supersededBy !== undefined) throw new Error(`horde: ${target} was superseded by F${f.supersededBy}`);
    if (f) return { owner: f.author, revision: findingRevision(f) };
  }
  if (/^I\d+$/.test(target)) {
    const i = listIdeas(ctx.hordeDir).find((entry) => entry.id === Number(target.slice(1)));
    if (i) return { owner: i.owner ?? "member-1", revision: hashText(JSON.stringify(i)) };
  }
  if (/^R\d+$/.test(target)) {
    const r = listResources(ctx.hordeDir).find((entry) => entry.id === Number(target.slice(1)));
    if (r) {
      const contract = state.resources.find((c) => c.target === target);
      return { owner: contract?.owner ?? r.owner, revision: hashText(JSON.stringify({ resource: r, contract })) };
    }
  }
  throw new Error(`horde: unknown target ${target}; use F#, I#, R#, A# or answer`);
}

/** Retain exact bytes before recording a revision; refuse paths escaping run artifacts. */
export function retainArtifact(ctx: EventContext, file: string): { path: string; hash: string; snapshot: string } {
  const runDir = path.join(ctx.hordeDir, "runs", ctx.runId);
  const root = fs.realpathSync(path.join(runDir, "artifacts"));
  const candidate = path.isAbsolute(file) ? file : path.join(runDir, file);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new Error(`horde: artifactPath not found: ${file}; artifacts live under runs/${ctx.runId}/artifacts/`);
  }
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw new Error("horde: evidence must be a file inside this run's artifacts directory");
  const bytes = fs.readFileSync(real);
  const hash = hashText(bytes);
  const snapshots = path.join(runDir, "revisions");
  fs.mkdirSync(snapshots, { recursive: true });
  const snapshot = path.join(snapshots, hash);
  if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot, bytes, { flag: "wx" });
  return { path: path.relative(runDir, real), hash, snapshot: path.relative(runDir, snapshot) };
}
