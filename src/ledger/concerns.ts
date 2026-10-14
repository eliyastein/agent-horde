import * as fs from "node:fs";
import { oneLine } from "../format.js";
import { appendEntry, hordePaths } from "./files.js";
import type { FindingMeta } from "./findings.js";
import { bestTextMatch, dedupTokens, textOverlap } from "./text-match.js";

interface ConcernEntry {
  slug: string;
  definition: string;
  author: string;
}

const CONCERN_LINE = /^- ([a-z0-9]+(?:-[a-z0-9]+)+): (.+?)(?:\s{2}@(\S+))?$/;

function parseConcerns(content: string): ConcernEntry[] {
  const entries: ConcernEntry[] = [];
  for (const line of content.split("\n")) {
    const match = CONCERN_LINE.exec(line);
    if (!match) continue;
    entries.push({ slug: match[1] ?? "", definition: match[2] ?? "", author: match[3] ?? "" });
  }
  return entries;
}

function formatConcern(entry: ConcernEntry): string {
  const author = entry.author ? `  @${entry.author}` : "";
  return `- ${entry.slug}: ${entry.definition}${author}`;
}

/** The glossary, oldest first; empty for a `.horde` directory that predates it. */
export function listConcerns(hordeDir: string): ConcernEntry[] {
  const file = hordePaths(hordeDir).concerns;
  if (!fs.existsSync(file)) return [];
  return parseConcerns(fs.readFileSync(file, "utf-8"));
}

function slugWords(slug: string): string {
  return slug.replace(/-/g, " ");
}

function sameTokenSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size !== b.size) return false;
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

/**
 * An existing concern that `slug` probably restates: the same words in another
 * order, a slug that only adds or drops a word, or a shared word plus a
 * near-identical definition. Slugs with no word in common never match, so two
 * definitions written to the same template cannot collide on their own.
 */
function similarConcern(
  existing: ConcernEntry[],
  slug: string,
  definition?: string,
): ConcernEntry | undefined {
  const tokens = dedupTokens(slugWords(slug));
  const related = existing.filter((entry) =>
    [...dedupTokens(slugWords(entry.slug))].some((token) => tokens.has(token)),
  );
  const reordered = related.find((entry) =>
    sameTokenSet(dedupTokens(slugWords(entry.slug)), tokens),
  );
  if (reordered) return reordered;
  // Overlap coefficient 1 means one slug's words are a subset of the other's:
  // `query-socketio-authz-bypass` restates `query-socketio-authz`, while
  // `login-form-csrf` beside `login-form-xss` is a different root cause.
  const overlap = textOverlap(related.map((entry) => slugWords(entry.slug)), slugWords(slug));
  if (overlap && overlap.shared >= 2 && overlap.overlap >= 1) return related[overlap.index];
  if (!definition) return undefined;
  const texts = related.map((entry) => `${slugWords(entry.slug)} ${entry.definition}`);
  const match = bestTextMatch(texts, `${slugWords(slug)} ${definition}`);
  return match === undefined ? undefined : related[match.index];
}

/**
 * Existing concerns sharing two or more slug words with `slug`. Lexical similarity cannot tell
 * `quill-marlow-partnership` (a synonym of `marlow-quill-company-overlap`) from
 * `query-socketio-csrf` beside `query-socketio-authz` (a different root cause), so this only advises.
 */
function overlappingConcerns(existing: ConcernEntry[], slug: string): Array<{ entry: ConcernEntry; shared: string[] }> {
  const tokens = dedupTokens(slugWords(slug));
  return existing.flatMap((entry) => {
    const shared = [...dedupTokens(slugWords(entry.slug))].filter((token) => tokens.has(token));
    return entry.slug !== slug && shared.length >= 2 ? [{ entry, shared }] : [];
  });
}

/**
 * Ensure a finding's concern is in CONCERNS.md. A slug already used by any
 * finding (legacy runs predate the glossary) passes; a look-alike of an existing
 * slug is refused unless the caller insists with a definition; a genuinely new
 * slug needs a definition. Runs inside the findings lock. Returns an advisory when the new
 * slug shares words with an existing one.
 */
export function registerConcern(
  hordeDir: string,
  usedSlugs: Set<string>,
  meta: FindingMeta,
  author: string,
): string | undefined {
  const slug = meta.concern;
  if (!slug) return undefined;
  const concerns = listConcerns(hordeDir);
  if (usedSlugs.has(slug) || concerns.some((entry) => entry.slug === slug)) return undefined;
  const similar = similarConcern(concerns, slug, meta.concernDef);
  if (similar && meta.concernNew !== true) {
    throw new Error(
      `horde: concern '${slug}' looks like '${similar.slug}' (${similar.definition}); ` +
        `use concern ${similar.slug}, or pass concernNew=true with a concernDef that says ` +
        "how it differs",
    );
  }
  const definition = oneLine(meta.concernDef ?? "", 200);
  if (definition === "") {
    throw new Error(
      `horde: '${slug}' is a new concern; pass concernDef=<one line naming its root cause ` +
        "and entry point>",
    );
  }
  appendEntry(hordePaths(hordeDir).concerns, `${formatConcern({ slug, definition, author })}\n`);
  const overlaps = overlappingConcerns(concerns, slug);
  if (!overlaps.length) return undefined;
  return `new concern '${slug}' shares words with ${overlaps.map(({ entry, shared }) => `'${entry.slug}' (${shared.join(", ")}): ${entry.definition}`).join("; ")}. ` +
    "If it names the same subject, file later findings under the existing slug.";
}
