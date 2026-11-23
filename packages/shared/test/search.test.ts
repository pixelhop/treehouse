import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  fuzzyMatch,
  searchPaths,
  type SearchItem,
} from "../search";

// These tests assert RELATIVE ORDERING, never absolute scores. The scoring
// weights in search.ts are tuned by hand, so a test pinned to a number would
// break on every tuning pass without indicating anything is actually wrong.

/** Build a candidate from a path, deriving the basename the way the callers do. */
const item = (path: string, isDir = false): SearchItem => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  isDir,
});

/** Rank `paths` against `query` and return just the ordered paths. */
function order(query: string, paths: string[], limit?: number): string[] {
  return searchPaths(
    query,
    paths.map((p) => item(p)),
    limit ? { limit } : {},
  ).results.map((r) => r.path);
}

describe("fuzzyMatch", () => {
  it("matches characters in order without requiring adjacency", () => {
    const m = fuzzyMatch("clinot", "Clients/acme/notes.md");
    expect(m).not.toBeNull();
    // Every matched position holds the character it claims to.
    const matched = m!.positions
      .map((i) => "Clients/acme/notes.md"[i])
      .join("")
      .toLowerCase();
    expect(matched).toBe("clinot");
  });

  it("returns null when the characters are not present in order", () => {
    expect(fuzzyMatch("zzz", "notes.md")).toBeNull();
    // Right characters, wrong order.
    expect(fuzzyMatch("dm", "md")).toBeNull();
  });

  it("returns null for an empty query", () => {
    expect(fuzzyMatch("", "notes.md")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("NOTES", "notes.md")).not.toBeNull();
    expect(fuzzyMatch("notes", "NOTES.MD")).not.toBeNull();
  });

  it("keeps positions inside the target when a character's lowercase is longer", () => {
    // U+0130 lowercases to two code units, so a naively-lowercased copy is longer
    // than the original and indices into it overflow the real string — which
    // misaligned highlighting and threw on the last character.
    const target = "\u0130stanbul";
    expect(() => searchPaths("il", [item(target)])).not.toThrow();
    const m = fuzzyMatch("istanbul", target);
    expect(m).not.toBeNull();
    expect(Math.max(...m!.positions)).toBeLessThan(target.length);
    expect(m!.positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("tightens the match window backwards rather than matching greedily forward", () => {
    // A greedy forward match takes the first `a` (index 0) and the `b` at index
    // 5, missing the tight `ab` at the end. The backward pass must find indices
    // 7 and 8 instead.
    const m = fuzzyMatch("ab", "a-xxxb-ab");
    expect(m).not.toBeNull();
    expect(m!.positions).toEqual([7, 8]);
  });

  it("picks the best alignment of LATER characters, not just the earliest", () => {
    // Trying every start position is not enough: with the first character pinned
    // at 0, a greedy scan takes the earliest `b` (index 2) and scores 10.55, while
    // the alignment [0,7,8] scores 12.55 because `bc` is consecutive. Optimal
    // alignment is the whole point of the DP.
    const m = fuzzyMatch("abc", "a_bxxxxbc");
    expect(m).not.toBeNull();
    expect(m!.positions).toEqual([0, 7, 8]);
  });

  it("scores a tightened match above a scattered one", () => {
    const tight = fuzzyMatch("ab", "xxxxxab")!;
    const scattered = fuzzyMatch("ab", "axxxxxb")!;
    expect(tight.score).toBeGreaterThan(scattered.score);
  });
});

describe("searchPaths ranking", () => {
  it("ranks an exact name match first", () => {
    const paths = ["archive/readme-old.md", "readme.md", "docs/readme-draft.md"];
    expect(order("readme.md", paths)[0]).toBe("readme.md");
  });

  it("ranks a prefix match above a mid-word match", () => {
    const paths = ["notes.md", "release-notes.md"];
    expect(order("notes", paths)[0]).toBe("notes.md");
  });

  it("ranks consecutive characters above scattered ones", () => {
    const paths = ["report.md", "r-e-p-o-r-t-x.md"];
    expect(order("report", paths)[0]).toBe("report.md");
  });

  it("ranks a name match above an ancestor-folder-only match", () => {
    const paths = ["reports/q1.md", "report.md"];
    expect(order("report", paths)[0]).toBe("report.md");
  });

  it("ranks a name match above a path match even when the path is short", () => {
    // `rep/x.md` matches `rep` only via its folder; `rep.md` matches by name.
    const paths = ["rep/x.md", "rep.md"];
    expect(order("rep", paths)[0]).toBe("rep.md");
  });

  it("prefers the shorter name among equally good matches", () => {
    const paths = ["notes-from-the-long-meeting.md", "notes.md"];
    expect(order("notes", paths)[0]).toBe("notes.md");
  });

  it("still finds deep path matches when nothing matches by name", () => {
    const paths = ["Clients/acme/notes.md", "unrelated.txt"];
    expect(order("clients", paths)).toEqual(["Clients/acme/notes.md"]);
  });

  it("marks path-only matches so the UI can highlight the right string", () => {
    const { results } = searchPaths("clients", [item("Clients/acme/notes.md")]);
    expect(results[0]!.matchedPath).toBe(true);
    // Positions index the PATH, not the name, when matchedPath is true.
    const matched = results[0]!.positions
      .map((i) => results[0]!.path[i])
      .join("")
      .toLowerCase();
    expect(matched).toBe("clients");
  });

  it("marks name matches as not path matches", () => {
    const { results } = searchPaths("notes", [item("Clients/acme/notes.md")]);
    expect(results[0]!.matchedPath).toBe(false);
    const matched = results[0]!.positions
      .map((i) => results[0]!.name[i])
      .join("")
      .toLowerCase();
    expect(matched).toBe("notes");
  });

  it("keeps the path penalty monotonic for deeply-scattered (negative-scoring) matches", () => {
    // A scattered match against a long path scores negative because the gap
    // penalty is unbounded. A naive `score * 0.6` would move a negative score UP
    // — inverting the penalty. The tighter path match must still win.
    const tighter = "aaa/bbb/clinot.x".replace("clinot.x", "zzz/clinotxxxx.md");
    const looser = "c-l-i-n-o-t".padEnd(90, "-") + "/x.md";
    const ranked = order("clinot", [looser, tighter]);
    expect(ranked[0]).toBe(tighter);
  });

  it("returns nothing for an empty or whitespace-only query", () => {
    const paths = [item("notes.md")];
    expect(searchPaths("", paths).results).toEqual([]);
    expect(searchPaths("   ", paths).results).toEqual([]);
    expect(searchPaths("   ", paths).totalMatches).toBe(0);
  });

  it("drops items that do not match at all", () => {
    expect(order("qqqq", ["notes.md", "readme.md"])).toEqual([]);
  });
});

describe("searchPaths determinism and limits", () => {
  it("breaks ties deterministically by path length then lexicographically", () => {
    // Same basename, same match quality — ordering must not depend on input order.
    const paths = ["bbb/notes.md", "aaa/notes.md", "cc/notes.md"];
    const forwards = order("notes", paths);
    const backwards = order("notes", [...paths].reverse());
    expect(forwards).toEqual(backwards);
    // Shortest path first, then lexicographic.
    expect(forwards).toEqual(["cc/notes.md", "aaa/notes.md", "bbb/notes.md"]);
  });

  it("truncates AFTER sorting, not before", () => {
    // The best match is last in input order; a limit of 1 must still return it.
    const paths = ["xnotesx.md", "notes-later.md", "notes.md"];
    expect(order("notes", paths, 1)).toEqual(["notes.md"]);
  });

  it("reports the pre-truncation match count", () => {
    const paths = ["notes.md", "notes-2.md", "notes-3.md"].map((p) => item(p));
    const outcome = searchPaths("notes", paths, { limit: 1 });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.totalMatches).toBe(3);
  });

  it("defaults to DEFAULT_SEARCH_LIMIT results", () => {
    const paths = Array.from({ length: 120 }, (_, i) => item(`notes-${i}.md`));
    const outcome = searchPaths("notes", paths);
    expect(outcome.results).toHaveLength(DEFAULT_SEARCH_LIMIT);
    expect(outcome.totalMatches).toBe(120);
  });

  it("clamps an absurd limit to MAX_SEARCH_LIMIT", () => {
    const paths = Array.from({ length: 500 }, (_, i) => item(`notes-${i}.md`));
    const outcome = searchPaths("notes", paths, { limit: 10_000_000 });
    expect(outcome.results).toHaveLength(MAX_SEARCH_LIMIT);
    expect(outcome.totalMatches).toBe(500);
  });
});

// A fixed corpus resembling a real workspace. Pairwise assertions above constrain
// almost nothing about eight interacting constants — a tuning pass that fixes one
// complaint can silently invert dozens of other orderings while every pairwise
// test stays green. This snapshot records the ordered top matches for a spread of
// realistic queries, so any tuning pass must review and re-approve a diff showing
// exactly which orderings moved. It deliberately snapshots PATHS ONLY, never
// scores, so it stays uncoupled from the constants themselves.
const CORPUS = [
  "AGENTS.md",
  "README.md",
  "00-Inbox/quick-note.md",
  "Clients/acme/README.md",
  "Clients/acme/notes.md",
  "Clients/acme/2026-q1-proposal.md",
  "Clients/acme/invoices/2026-01.pdf",
  "Clients/beta-corp/notes.md",
  "Clients/beta-corp/contract.pdf",
  "Content-Media-Marketing/blog/launch-post.md",
  "Content-Media-Marketing/social/calendar.md",
  "Design/brand/logo-usage.md",
  "Design/brand/colour-tokens.md",
  "Development/api/endpoints.md",
  "Development/api/authentication.md",
  "Development/runbooks/deploy.md",
  "Events/2026/summer-party.md",
  "Jozef Private/personal-notes.md",
  "reports/2026/q1-report.md",
  "reports/2026/q2-report.md",
];

describe("golden corpus", () => {
  const queries = [
    "readme",
    "notes",
    "acme",
    "clinot",
    "q1",
    "deploy",
    "api",
    "brand",
    "md",
    "report",
    "cal",
    "auth",
    "proposal",
    "inbox",
    "design",
  ];

  for (const query of queries) {
    it(`ranks "${query}" stably`, () => {
      expect(order(query, CORPUS, 10)).toMatchSnapshot();
    });
  }
});