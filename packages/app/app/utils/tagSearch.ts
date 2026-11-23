// The sidebar search's tag mode: a query starting with `#` searches tags rather
// than file names. While typing, `#pla` shows the tags starting with "pla" and
// every note carrying one. Once the query names a tag exactly, which is also what
// selecting a chip does, it shows that tag's notes and those nested under it
// (`#plan` finds `#plan/q4` but not `#planning`), and the chips still offer the
// longer tags.
import { DEFAULT_SEARCH_LIMIT, type SearchOutcome, searchPaths, tagKey } from "shared";

/** Whether a sidebar query is a tag search. */
export function isTagQuery(query: string): boolean {
  return query.trimStart().startsWith("#");
}

/** What the sidebar says when a tag query finds no notes. */
export function tagSearchEmptyText(
  query: string,
  state: { pending: boolean; indexing: boolean; anyTags: boolean },
): string {
  if (state.pending) return "Loading tags…";
  if (state.indexing) return "Still indexing older notes…";
  if (!state.anyTags) return "No tags yet. Add a #tag to a note, or tags: to its front matter.";
  return `No notes tagged “${query.trim()}”.`;
}

export interface TagMatch {
  tag: string;
  count: number;
}

/**
 * A tag query's two halves. `#planning road` is the tag `planning` and the file
 * name `road`, which is how a tag with more notes than the list shows is
 * searched. A tag may itself hold a space (`tags: [big project]`), so the whole
 * text counts as the tag when any tag starts with it.
 */
function splitQuery(
  text: string,
  tags: readonly { tag: string }[],
): { typed: string; name: string } {
  const space = text.search(/\s/);
  if (space === -1 || tags.some((t) => tagKey(t.tag).startsWith(text))) {
    return { typed: text, name: "" };
  }
  return { typed: text.slice(0, space), name: text.slice(space).trim() };
}

/** The tags a tag query matches, and the notes carrying them as search results. */
export function tagSearch(
  query: string,
  tags: readonly { tag: string; paths: string[] }[],
): { tags: TagMatch[]; outcome: SearchOutcome } {
  const { typed, name } = splitQuery(tagKey(query.trim().replace(/^#+/, "")), tags);
  const matched = tags.filter((t) => tagKey(t.tag).startsWith(typed));
  const exact = matched.some((t) => tagKey(t.tag) === typed);
  const carrying = exact
    ? matched.filter((t) => tagKey(t.tag) === typed || tagKey(t.tag).startsWith(`${typed}/`))
    : matched;
  const paths = [...new Set(carrying.flatMap((t) => t.paths))].sort();
  const items = paths.map((path) => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    isDir: false,
  }));
  const found = matched.map((t) => ({ tag: t.tag, count: t.paths.length }));
  if (name) return { tags: found, outcome: searchPaths(name, items) };
  return {
    tags: found,
    outcome: {
      // Capped like a file-name search; a bare `#` can match every note, and
      // adding part of a name after the tag reaches the rest.
      results: items
        .slice(0, DEFAULT_SEARCH_LIMIT)
        .map((item) => ({ ...item, score: 0, positions: [], matchedPath: false })),
      totalMatches: paths.length,
    },
  };
}