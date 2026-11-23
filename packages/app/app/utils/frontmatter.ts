// Split a leading YAML front-matter block off a markdown string. tiptap
// normalizes — and outright destroys — front-matter on round-trip, so it must
// never pass through the editor. We peel it off verbatim (fences, inner bytes,
// and trailing newline) before editing and re-attach it unchanged on save, so a
// human editing the body can never corrupt the metadata agents rely on.

export interface SplitMarkdown {
  /** The leading `---\n…\n---\n` block verbatim, or "" when absent. */
  frontMatter: string;
  /** The markdown body the editor should load. */
  body: string;
}

/**
 * Peel a leading front-matter block. A block exists only when the very first
 * line is exactly `---` and a later line is exactly `---`; the captured range
 * runs through the closing fence and its newline. A `---` that is a horizontal
 * rule mid-document, or an opening fence with no closing fence, is left in the
 * body untouched.
 */
export function splitFrontMatter(source: string): SplitMarkdown {
  const firstNl = source.indexOf("\n");
  if (firstNl === -1) return { frontMatter: "", body: source };
  if (source.slice(0, firstNl).replace(/\r$/, "") !== "---") {
    return { frontMatter: "", body: source };
  }

  let idx = firstNl + 1;
  while (idx <= source.length) {
    const nextNl = source.indexOf("\n", idx);
    const lineEnd = nextNl === -1 ? source.length : nextNl;
    const line = source.slice(idx, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      const end = nextNl === -1 ? source.length : nextNl + 1;
      return { frontMatter: source.slice(0, end), body: source.slice(end) };
    }
    if (nextNl === -1) break;
    idx = nextNl + 1;
  }
  // Opening fence with no closing fence — don't swallow real content.
  return { frontMatter: "", body: source };
}

/** Re-attach front-matter to a body. `frontMatter` already carries its newline. */
export function joinFrontMatter(frontMatter: string, body: string): string {
  return frontMatter + body;
}