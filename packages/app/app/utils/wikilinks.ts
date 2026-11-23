// Obsidian-style `[[wikilinks]]` in the markdown viewer.
//
// A `marked` inline extension tokenises `[[target#heading|alias]]` (and the
// `![[embed]]` form, which renders as a plain link — no transclusion) into an
// anchor carrying the raw target on `data-wikilink`. Resolution to a workspace
// path happens later, in the post-sanitize rewrite pass (see markdownRefs.ts),
// where the reader's file list is available. Parsing and resolution rules live
// in `shared` so the server's backlink index agrees with what renders here.
//
// The extension output is escaped and still passes through DOMPurify before the
// rewrite pass, so a target like `[[<img onerror=…>]]` can never smuggle markup
// through: the escaping keeps the HTML well-formed, DOMPurify makes it safe.
import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";
import { parseWikilinkInner, WIKILINK_START_RE, wikilinkLabel } from "shared";

interface WikilinkToken extends Tokens.Generic {
  type: "wikilink";
  target: string;
  fragment: string | null;
  text: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export const wikilinkExtension: TokenizerAndRendererExtension = {
  name: "wikilink",
  level: "inline",
  start(src: string) {
    const i = src.indexOf("[[");
    if (i === -1) return undefined;
    // Start at the `!` of an embed, so the tokenizer sees the whole thing.
    return i > 0 && src[i - 1] === "!" ? i - 1 : i;
  },
  tokenizer(src: string) {
    const m = WIKILINK_START_RE.exec(src);
    if (!m) return undefined;
    const parts = parseWikilinkInner(m[2] as string);
    // `[[]]` and `[[|x]]` name nothing: leave the brackets as text.
    if (!parts.target && !parts.fragment) return undefined;
    const token: WikilinkToken = {
      type: "wikilink",
      raw: m[0],
      target: parts.target,
      fragment: parts.fragment,
      text: wikilinkLabel(parts),
    };
    return token;
  },
  renderer(token) {
    const t = token as WikilinkToken;
    // Same-file heading link (`[[#Heading]]`): a native fragment anchor.
    if (!t.target && t.fragment) {
      return `<a href="#${escapeHtml(t.fragment)}">${escapeHtml(t.text)}</a>`;
    }
    const frag = t.fragment ? ` data-wikilink-fragment="${escapeHtml(t.fragment)}"` : "";
    // href="#" is an inert placeholder; the rewrite pass replaces it with the
    // resolved in-app route or marks the link unresolved.
    return `<a href="#" data-wikilink="${escapeHtml(t.target)}"${frag}>${escapeHtml(t.text)}</a>`;
  },
};

/**
 * The viewer's markdown renderer: marked's defaults plus wikilinks. Its own
 * instance rather than `marked.use` on the global one, so nothing else that
 * imports `marked` changes behaviour by accident.
 */
export const markdownRenderer = new Marked({ extensions: [wikilinkExtension] });