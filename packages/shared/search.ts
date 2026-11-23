// Fuzzy path matching and ranking, shared by the web app, the REST search
// endpoint, and the MCP `search_files` tool. It lives here — not in the app and
// not in the API — because all three must rank identically: a human and an agent
// searching the same workspace for the same thing should get the same answer in
// the same order. A client-only search library would have forced a second,
// inevitably divergent implementation on the server.
//
// "Fuzzy" means the query's characters must appear in the target in order, but
// need not be adjacent: `clinot` matches `Clients/acme/notes.md`.

/** A successful match: its score, and where in the target the characters landed. */
export interface FuzzyMatch {
  /** Higher is better. Only meaningful relative to other scores for the same query. */
  score: number;
  /** Indices into the target of each matched character, ascending. For highlighting. */
  positions: number[];
}

/** Characters after which a match counts as starting a new "word". */
const BOUNDARY_CHARS = new Set(["/", "-", "_", ".", " "]);

// Scoring weights. No theory produces these — they are tuned so that the
// orderings a person expects come out right. Because they are arbitrary, the
// tests assert RELATIVE ORDERING only, never absolute scores: tests coupled to
// these numbers would break on every tuning pass without indicating anything is
// actually wrong. See packages/shared/test/search.test.ts.
const CONSECUTIVE_BONUS = 8;
const BOUNDARY_BONUS = 6;
const PLAIN_CHAR_SCORE = 1;
const LEADING_PENALTY = 0.5;
const LEADING_PENALTY_CAP = 10;
const LENGTH_PENALTY = 0.05;
// Deliberately small relative to CONSECUTIVE_BONUS. An earlier value of 12 let a
// scattered match that merely started at index 0 outrank a tight one later in the
// string (`ab` scored `axxxxxb` above `xxxxxab`), because the bonus bought roughly
// twelve characters of gap. Starting at the beginning is worth something, but much
// less than actually being contiguous.
const PREFIX_BONUS = 4;
const EXACT_BONUS = 20;

/**
 * Matching on the full path rather than the basename is penalised, so a file
 * whose NAME matches beats one where only an ancestor folder does.
 *
 * Applied multiplicatively for non-negative scores and divisively for negative
 * ones, so the transform is monotonic across the whole range. This matters:
 * scattered matches against a long path routinely score negative (the gap
 * penalty is unbounded), and a plain `score * 0.6` would move a negative score
 * UP — inverting the very ordering the penalty exists to enforce.
 */
const PATH_MATCH_FACTOR = 0.6;

/** Default number of results returned when a caller does not ask for a specific limit. */
export const DEFAULT_SEARCH_LIMIT = 50;

/**
 * Hard ceiling on results, enforced regardless of what a caller passes. Shared
 * by the REST route and both MCP tools so the two cannot drift. Mirrors the
 * posture of MCP_MAX_LIST_ENTRIES in the MCP server: the safety cap must always
 * hold, because a listing-shaped tool with an unbounded limit is the cheapest
 * way to dump an entire workspace into a model's context.
 */
export const MAX_SEARCH_LIMIT = 200;

/**
 * Lowercase without changing length, so an index into the result is also a valid
 * index into the input.
 *
 * `String.prototype.toLowerCase()` can make a string LONGER — U+0130 (`İ`)
 * lowercases to two code units. Matching against a naively-lowercased copy and
 * then reporting those indices against the original overflows it: `positions`
 * ran past the end, which misaligned highlighting and boundary scoring and threw
 * outright on the last character. Folding each character individually and
 * keeping only its first unit when it expands preserves the 1:1 index mapping.
 * The cost is that `İ` matches as `i`, which is the right trade for a filename
 * matcher.
 */
function lowerAligned(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const lower = (input[i] as string).toLowerCase();
    out += lower.length === 1 ? lower : (lower[0] as string);
  }
  return out;
}

/** True when target[i] begins a new word (start, after punctuation, or a camelCase hump). */
function isWordBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1] as string;
  if (BOUNDARY_CHARS.has(prev)) return true;
  const cur = target[i] as string;
  // camelCase transition: a lowercase letter followed by an uppercase one.
  const prevIsLower = prev !== prev.toUpperCase() && prev === prev.toLowerCase();
  const curIsUpper = cur !== cur.toLowerCase() && cur === cur.toUpperCase();
  return prevIsLower && curIsUpper;
}

/** Score for matching one character, given whether it continues a run. */
function charScore(target: string, i: number, consecutive: boolean): number {
  if (consecutive) return CONSECUTIVE_BONUS;
  return isWordBoundary(target, i) ? BOUNDARY_BONUS : PLAIN_CHAR_SCORE;
}

// Reusable scratch buffers. The matcher runs once per candidate per keystroke —
// thousands of times — so allocating fresh arrays each call would dominate its
// cost. Safe because the function is synchronous and non-reentrant.
let scratchPrev = new Float64Array(0);
let scratchCur = new Float64Array(0);
let scratchParent = new Int32Array(0);
const NEG = Number.NEGATIVE_INFINITY;

function ensureScratch(rows: number, cols: number): void {
  if (scratchPrev.length < cols) {
    scratchPrev = new Float64Array(cols);
    scratchCur = new Float64Array(cols);
  }
  if (scratchParent.length < rows * cols) scratchParent = new Int32Array(rows * cols);
}

/**
 * Match `queryLower` (already folded by the caller) against `target`, returning
 * the BEST-scoring alignment and where its characters landed.
 *
 * Exact, not greedy. Two earlier versions of this were heuristics and both
 * mis-ranked real inputs:
 *
 *   - Forward-then-backward tightening only ever shrank the FIRST window in
 *     which the query completed, so it could not see a better window later:
 *     `ab` against `a-xxxb-ab` returned the loose `a…b` and missed `ab`.
 *   - Trying every start position fixed that, but still took the earliest
 *     occurrence of every LATER character. `abc` against `a_bxxxxbc` returned
 *     [0,2,8] (10.55) rather than [0,7,8] (12.55), where `bc` is consecutive.
 *
 * Both are the same mistake — committing to a local choice — so this does the
 * real thing instead, in O(query x target) with a running maximum.
 *
 * The recurrence works because the gap penalty is `last - first`, which telescopes
 * into "charge 1 for every target position advanced after the first match". That
 * makes the cost local, so with `f[j][i]` = best value of an alignment of the
 * first j+1 query characters ending at target index i:
 *
 *     f[j][i] = max(
 *       max over p < i of (f[j-1][p] + p) - i + charScore(i, not consecutive),
 *       f[j-1][i-1] - 1 + CONSECUTIVE_BONUS,
 *     )
 *
 * The inner max is a prefix maximum, carried as a running value, so each cell is
 * O(1). Each transition charges (i - p), which telescopes to exactly
 * `last - first` — so the gap penalty needs no separate term. Values that depend
 * only on the first matched index (leading penalty, prefix bonus) are folded into
 * row 0; values that depend only on the whole string (length penalty, exact-match
 * bonus) are added at the end.
 */
export function fuzzyMatchLower(queryLower: string, target: string): FuzzyMatch | null {
  const k = queryLower.length;
  if (!k) return null;
  // Length-preserving: `positions` must index `target`, not a longer copy.
  const lowerTarget = lowerAligned(target);
  const n = lowerTarget.length;
  if (k > n) return null;

  // Cheap reject: is the query a subsequence at all? Keeps the (overwhelmingly
  // common) non-matching case at O(n) and off the DP.
  let probe = 0;
  for (let i = 0; i < n && probe < k; i++) {
    if (lowerTarget[i] === queryLower[probe]) probe += 1;
  }
  if (probe < k) return null;

  ensureScratch(k, n);
  const parent = scratchParent;
  let prev = scratchPrev;
  let cur = scratchCur;

  // Row 0 — the first matched character. `+ i` represents `+ first` from the
  // telescoped gap penalty; the matching `- last` falls out of the final step.
  for (let i = 0; i < n; i++) {
    prev[i] =
      lowerTarget[i] === queryLower[0]
        ? charScore(target, i, false) -
          LEADING_PENALTY * Math.min(i, LEADING_PENALTY_CAP) +
          (i === 0 ? PREFIX_BONUS : 0)
        : NEG;
  }

  for (let j = 1; j < k; j++) {
    const qc = queryLower[j];
    let bestPrefix = NEG; // max over p <= i-1 of (prev[p] + p)
    let bestPrefixAt = -1;
    for (let i = 0; i < n; i++) {
      if (i > 0 && prev[i - 1] !== NEG) {
        const v = prev[i - 1]! + (i - 1);
        if (v > bestPrefix) {
          bestPrefix = v;
          bestPrefixAt = i - 1;
        }
      }
      if (lowerTarget[i] !== qc) {
        cur[i] = NEG;
        continue;
      }
      let best = NEG;
      let from = -1;
      if (bestPrefix !== NEG) {
        best = bestPrefix - i + charScore(target, i, false);
        from = bestPrefixAt;
      }
      if (i > 0 && prev[i - 1] !== NEG) {
        const consec = prev[i - 1]! - 1 + CONSECUTIVE_BONUS;
        if (consec > best) {
          best = consec;
          from = i - 1;
        }
      }
      cur[i] = best;
      parent[j * n + i] = from;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }

  // Close out with the terms that depend on the whole string rather than on any
  // one position. The gap penalty is already paid: each transition charges
  // (i - p), which telescopes to exactly `last - first`.
  let bestScore = NEG;
  let bestEnd = -1;
  for (let i = 0; i < n; i++) {
    const score = prev[i]!;
    if (score === NEG) continue;
    if (score > bestScore) {
      bestScore = score;
      bestEnd = i;
    }
  }
  if (bestEnd === -1) return null;

  bestScore += k - 1;
  bestScore -= LENGTH_PENALTY * n;
  if (queryLower === lowerTarget) bestScore += EXACT_BONUS;

  const positions = new Array<number>(k);
  let at = bestEnd;
  for (let j = k - 1; j >= 0; j--) {
    positions[j] = at;
    if (j > 0) at = parent[j * n + at] as number;
  }

  return { score: bestScore, positions };
}

/** Convenience wrapper that lowercases the query itself. Prefer `fuzzyMatchLower` in a loop. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  return fuzzyMatchLower(lowerAligned(query), target);
}

/** A candidate for search: one file or synthesized folder. */
export interface SearchItem {
  path: string;
  name: string;
  isDir: boolean;
}

export interface SearchResult extends SearchItem {
  score: number;
  /** Indices into `name`, or into `path` when `matchedPath` is true. */
  positions: number[];
  /** True when the basename did not match and the full path was scored instead. */
  matchedPath: boolean;
}

export interface SearchOutcome {
  /** Best first, truncated to the limit. */
  results: SearchResult[];
  /** How many items matched BEFORE truncation, so callers can report what was cut off. */
  totalMatches: number;
}

/**
 * Rank `items` against `query`, best first.
 *
 * Returns the pre-truncation match count alongside the results: the REST route
 * reports it as `truncated`, and the sidebar shows "showing 50 of N". Without it
 * a caller would have to re-run the whole scorer just to learn it capped.
 *
 * Ordering is fully deterministic — score, then shorter path, then
 * lexicographic. That is required, not cosmetic: the client and the server must
 * produce identical orderings, and non-deterministic ties make tests flaky.
 *
 * Scaling note: `positions` are computed for every candidate and then discarded
 * for all but the top `limit`. At a few thousand candidates that is free. If it
 * ever isn't, the fix is two-phase — score only, then recompute positions for
 * the surviving top-N — rather than anything cleverer.
 */
export function searchPaths(
  query: string,
  items: readonly SearchItem[],
  options: { limit?: number } = {},
): SearchOutcome {
  // Same folding as the target side, so both sides agree on what a character is.
  const queryLower = lowerAligned(query.trim());
  if (!queryLower) return { results: [], totalMatches: 0 };

  const limit = Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const matches: SearchResult[] = [];

  for (const item of items) {
    const byName = fuzzyMatchLower(queryLower, item.name);
    if (byName) {
      matches.push({
        ...item,
        score: byName.score,
        positions: byName.positions,
        matchedPath: false,
      });
      continue;
    }
    const byPath = fuzzyMatchLower(queryLower, item.path);
    if (byPath) {
      const score =
        byPath.score >= 0 ? byPath.score * PATH_MATCH_FACTOR : byPath.score / PATH_MATCH_FACTOR;
      matches.push({ ...item, score, positions: byPath.positions, matchedPath: true });
    }
  }

  matches.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );

  return { results: matches.slice(0, limit), totalMatches: matches.length };
}