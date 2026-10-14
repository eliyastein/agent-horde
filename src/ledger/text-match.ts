// Write-time duplicate detection. Short ideas use Jaccard; long, differently
// worded ideas use identifier overlap (bug ids, paths, symbols) or the overlap
// coefficient, because Jaccard shrinks as the text grows.
const DEDUP_THRESHOLD = 0.75;

const DEDUP_OVERLAP_THRESHOLD = 0.6;

const DEDUP_MIN_SHARED = 3;

const DEDUP_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "be", "it", "this", "that", "all", "any", "via", "from", "into", "as",
]);

// Hard identifiers that make two statements the same task even when worded
// very differently. The bare 7-8 digit case requires a CL/bug prefix so an
// unrelated number does not merge two ideas.
const IDENTIFIER_PATTERNS: RegExp[] = [
  /\b\d{9}\b/g,
  /\b(?:CL|crbug|bug)\s*#?(\d{6,9})\b/gi,
  /(?:[\w.@-]+\/)+[\w.-]+\.\w{1,5}\b/g,
  /\b[a-z][a-z0-9]*_[a-z0-9_]{3,}\b/g,
];

function dedupIdentifiers(text: string): Set<string> {
  const keys = new Set<string>();
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? match[0]).toLowerCase();
      if (value.length >= 4) keys.add(value);
    }
  }
  return keys;
}

// Strong topic anchors for clustering. Weaker identifiers (bare file names,
// snake_case symbols) are deliberately excluded so two distinct bugs in the
// same file are not merged.
const ANCHOR_PATTERNS: RegExp[] = [
  /\b\d{9}\b/g,
  /\b[0-9a-f]{24,64}\b/g,
  /https?:\/\/[^\s)"'`]+/g,
  /\b(?:CL|crbug|bug)\s*#?(\d{6,9})\b/gi,
];

export function dedupAnchors(text: string): Set<string> {
  const keys = new Set<string>();
  for (const pattern of ANCHOR_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? match[0]).toLowerCase();
      if (value.length >= 6) keys.add(value);
    }
  }
  return keys;
}

// Strong entity identifiers the generic anchors miss: domains/hosts, IP
// addresses, autonomous-system numbers, and dates. These are not tied to one
// task type; they recur across infra, incident response, log and network
// analysis, and investigation work. They are used only by fact dedup, which also
// requires shared salient tokens, so two distinct facts about the same entity (a
// DNS record and a registration date for one host, say) are not merged. Adding
// them to the clustering anchors would collapse separate findings that share a
// root host, so they stay scoped to fact dedup.
const ENTITY_PATTERNS: RegExp[] = [
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\bAS\d{2,6}\b/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
];

export function factAnchors(text: string): Set<string> {
  const keys = dedupAnchors(text);
  for (const pattern of ENTITY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? match[0]).toLowerCase();
      if (value.length >= 4) keys.add(value);
    }
  }
  return keys;
}

const STEM_ALIASES: Record<string, string> = {
  analysis: "analyz",
  analyse: "analyz",
  analyze: "analyz",
  analysed: "analyz",
  analyzed: "analyz",
  analysing: "analyz",
  analyzing: "analyz",
  disassembly: "disassembl",
  disassemble: "disassembl",
  disassembling: "disassembl",
};

/** Crude suffix stem so `statically analyze` matches `static analysis`. */
function stemToken(token: string): string {
  const alias = STEM_ALIASES[token];
  if (alias) return alias;
  if (token.length > 4 && token.endsWith("ally")) return token.slice(0, -4);
  if (token.length > 4 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function dedupTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !DEDUP_STOPWORDS.has(token))
    .map(stemToken);
  return new Set(tokens);
}

/** Longer stemmed tokens, used where a shared term is a strong signal (facts, claims). */
export function salientTokens(text: string): Set<string> {
  return new Set([...dedupTokens(text)].filter((token) => token.length >= 4));
}

interface TextMatch {
  index: number;
  identifier: boolean;
  jaccard: number;
  overlap: number;
  shared: number;
}

export function bestTextMatch(existing: string[], target: string): TextMatch | undefined {
  const targetTokens = dedupTokens(target);
  const targetKeys = dedupIdentifiers(target);
  if (targetTokens.size === 0 && targetKeys.size === 0) return undefined;
  let best: TextMatch | undefined;
  const rank = (match: TextMatch): number =>
    match.identifier ? 2 : Math.max(match.jaccard, match.overlap);
  existing.forEach((text, index) => {
    const keys = dedupIdentifiers(text);
    const identifier = [...targetKeys].some((key) => keys.has(key));
    const other = dedupTokens(text);
    const shared = [...targetTokens].filter((token) => other.has(token)).length;
    const union = targetTokens.size + other.size - shared;
    const jaccard = union === 0 ? 0 : shared / union;
    const min = Math.min(targetTokens.size, other.size);
    const overlap = min === 0 ? 0 : shared / min;
    const candidate: TextMatch = { index, identifier, jaccard, overlap, shared };
    if (!best || rank(candidate) > rank(best)) best = candidate;
  });
  if (!best) return undefined;
  if (best.identifier) return best;
  if (targetTokens.size < DEDUP_MIN_SHARED) {
    return best.jaccard >= DEDUP_THRESHOLD ? best : undefined;
  }
  const meets =
    best.shared >= DEDUP_MIN_SHARED &&
    (best.jaccard >= DEDUP_THRESHOLD || best.overlap >= DEDUP_OVERLAP_THRESHOLD);
  return meets ? best : undefined;
}

/** Drop a leading "[T27]" / "[F12]" / "F12:" id a member may paste into a body. */
export function stripLeadingId(text: string): string {
  return text.replace(/^\s*\[?[TF]\s?\d+\]?\s*[:.-]?\s*/i, "").trim();
}

/** Similarity of two idea/finding texts, for collision checks. */
interface TextOverlap {
  index: number;
  identifier: boolean;
  jaccard: number;
  overlap: number;
  shared: number;
}

/** Compare `target` against each of `existing`, keeping the strongest match. */
export function textOverlap(existing: string[], target: string): TextOverlap | undefined {
  const targetTokens = dedupTokens(target);
  const targetKeys = dedupIdentifiers(target);
  if (targetTokens.size === 0 && targetKeys.size === 0) return undefined;
  let best: TextOverlap | undefined;
  existing.forEach((text, index) => {
    const keys = dedupIdentifiers(text);
    const identifier = [...targetKeys].some((key) => keys.has(key));
    const other = dedupTokens(text);
    const shared = [...targetTokens].filter((token) => other.has(token)).length;
    const union = targetTokens.size + other.size - shared;
    const jaccard = union === 0 ? 0 : shared / union;
    const min = Math.min(targetTokens.size, other.size);
    const overlap = min === 0 ? 0 : shared / min;
    const candidate: TextOverlap = { index, identifier, jaccard, overlap, shared };
    const rank = (m: TextOverlap): number => (m.identifier ? 2 : Math.max(m.jaccard, m.overlap));
    if (!best || rank(candidate) > rank(best)) best = candidate;
  });
  return best;
}

/** True when two texts are close enough to be the same work, not just the same topic. */
export function hardOverlap(match: TextOverlap): boolean {
  return (
    match.identifier ||
    (match.shared >= DEDUP_MIN_SHARED &&
      (match.jaccard >= DEDUP_THRESHOLD || match.overlap >= DEDUP_OVERLAP_THRESHOLD))
  );
}
