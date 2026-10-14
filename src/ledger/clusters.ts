import { findingConfidenceRank, findingImportanceRank, findingSupportRank } from "./findings.js";
import type { FindingEntry } from "./findings.js";
import { dedupAnchors, dedupTokens } from "./text-match.js";

/** Two findings cluster together at this token overlap (looser than exact dedup). */
export const CLUSTER_THRESHOLD = 0.4;

export interface FindingCluster {
  representative: FindingEntry;
  members: string[];
  /** Members whose evidence arrived as a declared delta, not a direct report. */
  deltaMembers: string[];
  findings: FindingEntry[];
}

function clusterImportance(cluster: FindingCluster): number {
  return Math.max(0, ...cluster.findings.map(findingImportanceRank));
}

function clusterSupport(cluster: FindingCluster): number {
  return Math.max(0, ...cluster.findings.map(findingSupportRank));
}

function clusterConfidence(cluster: FindingCluster): number {
  return Math.max(0, ...cluster.findings.map(findingConfidenceRank));
}

function clusterVerified(cluster: FindingCluster): number {
  return cluster.findings.some((finding) => finding.verifiedBy) ? 1 : 0;
}

/**
 * Group findings by content overlap. Ranking is (independently verified, max
 * support, max importance, independent members, confidence, entries), so one loud
 * member cannot outrank a finding several members reached independently, and a
 * reproduction by the verifier outranks any self-assessed label. All labels are
 * optional; unlabeled findings rank below labeled ones and otherwise by id.
 */
export function clusterFindings(entries: FindingEntry[]): FindingCluster[] {
  interface Draft {
    anchor: FindingEntry;
    findings: FindingEntry[];
  }
  const drafts: Draft[] = [];
  for (const entry of entries) {
    const text = `${entry.title}\n${entry.body}`;
    const tokens = dedupTokens(text);
    const keys = dedupAnchors(text);
    let target: Draft | undefined;
    let best = 0;
    for (const draft of drafts) {
      // Concern is authoritative. It combines root cause and affected entry point,
      // preventing similar impact language from merging unrelated issues.
      if (entry.concern || draft.anchor.concern) {
        if (entry.concern && entry.concern === draft.anchor.concern) {
          target = draft;
          best = 1;
          break;
        }
        continue;
      }
      const repText = `${draft.anchor.title}\n${draft.anchor.body}`;
      const repKeys = dedupAnchors(repText);
      // A shared hard identifier (path, endpoint, hash, bug id) is a topic anchor,
      // so it clusters even when the wording differs.
      if ([...keys].some((key) => repKeys.has(key))) {
        target = draft;
        best = 1;
        break;
      }
      const rep = dedupTokens(repText);
      const inter = [...tokens].filter((token) => rep.has(token)).length;
      const union = tokens.size + rep.size - inter;
      const score = union === 0 ? 0 : inter / union;
      if (score > best) {
        best = score;
        target = draft;
      }
    }
    if (target && best >= CLUSTER_THRESHOLD) target.findings.push(entry);
    else drafts.push({ anchor: entry, findings: [entry] });
  }

  // Fold each declared delta into the cluster that holds the finding it names,
  // following delta chains to their root. Doing this per finding means a delta
  // whose body content-clustered elsewhere still joins its declared parent, and
  // its importance no longer inflates an unrelated cluster.
  const byId = new Map<number, FindingEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const ownerOf = new Map<number, Draft>();
  for (const draft of drafts) for (const finding of draft.findings) ownerOf.set(finding.id, draft);
  const rootIdOf = (finding: FindingEntry, seen = new Set<number>()): number => {
    if (finding.deltaOf === undefined || seen.has(finding.id)) return finding.id;
    seen.add(finding.id);
    const parent = byId.get(finding.deltaOf);
    return parent ? rootIdOf(parent, seen) : finding.deltaOf;
  };
  for (const draft of drafts) {
    // oxlint-disable-next-line unicorn/no-useless-spread -- the loop splices draft.findings
    for (const finding of [...draft.findings]) {
      if (finding.deltaOf === undefined) continue;
      const root = byId.get(rootIdOf(finding));
      // Malformed or legacy hand-edited metadata cannot override an explicit
      // concern boundary. The report keeps both findings visible instead.
      if (finding.concern && root?.concern && finding.concern !== root.concern) continue;
      const parent = ownerOf.get(rootIdOf(finding));
      if (!parent || parent === draft) continue;
      draft.findings.splice(draft.findings.indexOf(finding), 1);
      parent.findings.push(finding);
      ownerOf.set(finding.id, parent);
    }
  }

  return drafts
    .filter((draft) => draft.findings.length > 0)
    .map((draft) => {
      // A cluster is represented by its root finding: a non-delta with the lowest id.
      const representative = [...draft.findings].sort((a, b) => {
        const rank = (finding: FindingEntry): number => (finding.deltaOf === undefined ? 0 : 1);
        return rank(a) - rank(b) || a.id - b.id;
      })[0]!;
      const members: string[] = [];
      const deltaMembers: string[] = [];
      for (const finding of draft.findings) {
        for (const name of [finding.author, ...finding.corroborators]) {
          const list = finding.deltaOf === undefined ? members : deltaMembers;
          if (!list.includes(name)) list.push(name);
        }
      }
      return {
        representative,
        members,
        deltaMembers: deltaMembers.filter((name) => !members.includes(name)),
        findings: draft.findings,
      };
    })
    .sort(
      (a, b) =>
        clusterVerified(b) - clusterVerified(a) ||
        clusterSupport(b) - clusterSupport(a) ||
        clusterImportance(b) - clusterImportance(a) ||
        b.members.length - a.members.length ||
        clusterConfidence(b) - clusterConfidence(a) ||
        b.findings.length - a.findings.length ||
        a.representative.id - b.representative.id,
    );
}
