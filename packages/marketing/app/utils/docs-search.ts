import type { FuseResult, FuseResultMatch, IFuseOptions } from "fuse.js";

/**
 * Docs search ranking, shared by the Cmd+K palette (`useDocsSearch`) and the
 * findability tests (`tests/docs/findability.spec.ts`), so the tests exercise
 * exactly what users get.
 *
 * Pure: Fuse itself is injected (the palette lazy-loads it), only types are
 * imported here.
 */

export interface DocsSearchEntry {
  url: string;
  title: string;
  titles: string[];
  content: string;
  /**
   * Other names for the page (its `navTitle` and `seoTitle`), on the page-level
   * entry only. Searchable, never displayed: the SEO title is usually phrased
   * the way people search ("Files not syncing?").
   */
  aliases?: string[];
}

export type DocsSearchResult = FuseResult<DocsSearchEntry>;

/** Minimal Fuse surface the ranker needs (keeps this module Fuse-free at runtime). */
export interface DocsFuseLike {
  search(pattern: string): DocsSearchResult[];
}

export const DOCS_FUSE_OPTIONS: IFuseOptions<DocsSearchEntry> = {
  keys: [
    { name: "title", weight: 0.5 },
    { name: "aliases", weight: 0.3 },
    { name: "titles", weight: 0.3 },
    { name: "content", weight: 0.2 },
  ],
  ignoreLocation: true,
  threshold: 0.3,
  includeMatches: true,
  includeScore: true,
  minMatchCharLength: 2,
};

/** Cap on the rendered hit list. */
export const DOCS_SEARCH_LIMIT = 12;

// Words that carry no signal in a support question ("how do I ...", "what
// happens when ..."). Fuse matches a pattern as one fuzzy string, so a whole
// natural-language question almost never matches; searching the meaningful
// words separately and ranking by how many matched is what makes questions work.
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "get",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "not",
  "of",
  "on",
  "or",
  "our",
  "so",
  "the",
  "this",
  "that",
  "to",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your",
]);

/** Lower-cased, de-duplicated meaningful words of a query. */
export function tokenizeDocsQuery(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
  return [...new Set(words)];
}

interface Aggregate {
  result: DocsSearchResult;
  hits: number;
  quality: number;
  matches: FuseResultMatch[];
}

/**
 * Rank docs sections for a query: each meaningful word is searched on its own,
 * and sections are ordered by how many words they matched, then by summed match
 * quality (Fuse score, which already weights title > titles > content). A query
 * made only of stopwords falls back to a plain whole-string search.
 */
export function rankDocsSearch(
  fuse: DocsFuseLike,
  query: string,
  limit = DOCS_SEARCH_LIMIT,
): DocsSearchResult[] {
  const term = query.trim();
  if (!term) return [];

  const tokens = tokenizeDocsQuery(term);
  if (tokens.length <= 1) {
    return fuse.search(tokens[0] ?? term).slice(0, limit);
  }

  const byRef = new Map<number, Aggregate>();
  for (const token of tokens) {
    for (const result of fuse.search(token)) {
      const existing = byRef.get(result.refIndex);
      const quality = 1 - (result.score ?? 1);
      if (existing) {
        existing.hits += 1;
        existing.quality += quality;
        existing.matches.push(...(result.matches ?? []));
      } else {
        byRef.set(result.refIndex, {
          result,
          hits: 1,
          quality,
          matches: [...(result.matches ?? [])],
        });
      }
    }
  }

  return [...byRef.values()]
    .sort(
      (a, b) => b.hits - a.hits || b.quality - a.quality || a.result.refIndex - b.result.refIndex,
    )
    .slice(0, limit)
    .map((aggregate) => ({
      ...aggregate.result,
      score: 1 - aggregate.quality / tokens.length,
      matches: mergeMatches(aggregate.matches),
    }));
}

/** Merge per-token matches into one entry per key so highlighting sees them all. */
function mergeMatches(matches: FuseResultMatch[]): FuseResultMatch[] {
  const byKey = new Map<string, FuseResultMatch>();
  for (const match of matches) {
    const key = `${match.key}:${match.refIndex ?? ""}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.indices = [...existing.indices, ...match.indices];
    } else {
      byKey.set(key, { ...match, indices: [...match.indices] });
    }
  }
  return [...byKey.values()];
}

/** Page path of a result URL (drops the `#section` anchor). */
export function docsSearchResultPage(url: string): string {
  return url.split("#")[0] || url;
}

/**
 * The search term from a route's `?q=` value (`/docs?q=term`): the first value
 * when repeated, trimmed; empty when absent.
 */
export function docsSearchQueryParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}