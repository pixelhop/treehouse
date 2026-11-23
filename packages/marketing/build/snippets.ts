/**
 * Code shown on the marketing site, highlighted at build time.
 *
 * Shiki runs inside a Vite virtual module rather than in the browser: the
 * grammars and themes are large, and this is a handful of fixed snippets that
 * never change at runtime. The page receives finished HTML and ships no
 * highlighter at all.
 *
 * The theme is the brand palette rather than an off-the-shelf one — a stock
 * dark theme drops colours (electric blues, magentas) that appear nowhere else
 * in Treehouse, which is what made these blocks feel like foreign objects.
 */
import { createHighlighter, type ThemeRegistration } from "shiki";

const treehouseDark: ThemeRegistration = {
  name: "treehouse-dark",
  type: "dark",
  colors: {
    "editor.background": "#2B2F33", // charcoal
    "editor.foreground": "#EFE9DC", // parchment
  },
  settings: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8E9387" } },
    { scope: ["string", "string.quoted", "meta.string"], settings: { foreground: "#A8C5A1" } }, // sage
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#C89A5B" } }, // wood
    {
      scope: ["keyword", "storage.type", "storage.modifier", "keyword.operator"],
      settings: { foreground: "#6BA368" }, // moss
    },
    {
      scope: ["entity.name.function", "support.function", "variable.function"],
      settings: { foreground: "#D6E6F7" }, // sky — the "agent" colour
    },
    {
      scope: ["support.type.property-name", "meta.object-literal.key", "variable.other.member"],
      settings: { foreground: "#8FBF9F" },
    },
    { scope: ["variable", "variable.other"], settings: { foreground: "#EFE9DC" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#8E9387" } },
  ],
};

export type Snippet = { lang: string; label: string; code: string };

export const snippets = {
  // The real setup, as the docs give it (docs/agents/connect/claude-code.md):
  // browser sign-in, no key to paste. Keep the two in step.
  mcp: {
    lang: "bash",
    label: "claude code",
    code: `$ claude mcp add --transport http treehouse \\
    https://api.trytree.house/api/mcp

$ claude
> /mcp    # sign in to Treehouse in your browser`,
  },
} satisfies Record<string, Snippet>;

/** Vite plugin exposing the finished HTML as `virtual:treehouse-snippets`. */
export function snippetHighlighter() {
  const VIRTUAL = "virtual:treehouse-snippets";
  const RESOLVED = "\0" + VIRTUAL;

  return {
    name: "treehouse-snippet-highlighter",
    resolveId(id: string) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    async load(id: string) {
      if (id !== RESOLVED) return null;

      const highlighter = await createHighlighter({
        themes: [treehouseDark],
        langs: [...new Set(Object.values(snippets).map((s) => s.lang))],
      });

      const out: Record<string, { label: string; html: string }> = {};
      for (const [key, snippet] of Object.entries(snippets)) {
        out[key] = {
          label: snippet.label,
          html: highlighter.codeToHtml(snippet.code, {
            lang: snippet.lang,
            theme: "treehouse-dark",
          }),
        };
      }
      highlighter.dispose();

      return `export default ${JSON.stringify(out)};`;
    },
  };
}