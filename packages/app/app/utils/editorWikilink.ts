// `[[wikilinks]]` in the Tiptap markdown editor.
//
// Without this node a wikilink reached the editor as plain text, and the
// markdown serializer escaped it on save: `[[Note|alias]]` came back as
// `\[\[Note|alias\]\]`, silently breaking every link in a note the moment
// someone edited it. The node keeps the inner text exactly as written and
// serializes it back verbatim, so a load → save round trip is byte-identical.
//
// Display follows the viewer: the alias (else the target) as a link-styled
// chip, muted when it names no file the reader can see. Typing or pasting
// `[[…]]` makes a link; Backspace just after one turns it back into text with
// the closing bracket removed, so it can be edited and closed again.
// ⌘/Ctrl-click opens the linked file.
import { InputRule, Node, nodePasteRule } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { parseWikilinkInner, WIKILINK_START_RE, wikilinkLabel } from "shared";

export interface EditorWikilinkContext {
  /** Resolve a target against the files the reader can see (see FileSource.paths). */
  resolve: (target: string) => string | null;
  /** Open a resolved file from a ⌘/Ctrl-click. */
  open: (path: string, fragment: string | null, event: MouseEvent) => void;
}

/** The markdown a wikilink node serializes to. */
function source(attrs: { inner: string; embed: boolean }): string {
  return `${attrs.embed ? "!" : ""}[[${attrs.inner}]]`;
}

/**
 * The wikilink node. `getCtx` is read lazily, so the editor works without a
 * workspace (links then render unresolved and don't open).
 */
export function wikilinkNode(getCtx: () => EditorWikilinkContext | null) {
  return Node.create({
    name: "wikilink",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        inner: { default: "" },
        embed: { default: false },
      };
    },

    parseHTML() {
      return [
        {
          tag: "span[data-wikilink]",
          getAttrs: (el: HTMLElement) => ({
            inner: el.getAttribute("data-wikilink") ?? "",
            embed: el.hasAttribute("data-wikilink-embed"),
          }),
        },
      ];
    },

    renderHTML({ node }) {
      const inner = node.attrs.inner as string;
      const parts = parseWikilinkInner(inner);
      const path = parts.target ? (getCtx()?.resolve(parts.target) ?? null) : null;
      // A same-note heading link (`[[#Heading]]`) has nothing to resolve.
      const resolved = path !== null || !parts.target;
      return [
        "span",
        {
          "data-wikilink": inner,
          ...(node.attrs.embed ? { "data-wikilink-embed": "" } : {}),
          class: resolved ? "wikilink" : "wikilink wikilink-unresolved",
          title: path
            ? `${path} — ⌘-click to open`
            : resolved
              ? undefined
              : `No file named “${parts.target}”`,
        },
        wikilinkLabel(parts),
      ];
    },

    renderText({ node }) {
      return source(node.attrs as { inner: string; embed: boolean });
    },

    markdownTokenizer: {
      name: "wikilink",
      level: "inline",
      start: (src: string) => {
        const i = src.indexOf("[[");
        return i > 0 && src[i - 1] === "!" ? i - 1 : i;
      },
      tokenize: (src: string) => {
        const m = WIKILINK_START_RE.exec(src);
        if (!m) return undefined;
        const parts = parseWikilinkInner(m[2] as string);
        if (!parts.target && !parts.fragment) return undefined;
        return { type: "wikilink", raw: m[0], inner: m[2], embed: m[1] === "!" };
      },
    },

    parseMarkdown: (token) => ({
      type: "wikilink",
      attrs: { inner: String(token.inner ?? ""), embed: token.embed === true },
    }),

    renderMarkdown: (node: { attrs?: Record<string, unknown> }) => {
      const inner = node.attrs?.inner;
      return source({
        inner: typeof inner === "string" ? inner : "",
        embed: node.attrs?.embed === true,
      });
    },

    addInputRules() {
      return [
        new InputRule({
          find: /(!?)\[\[([^[\]\n]+?)\]\]$/,
          handler: ({ state, range, match }) => {
            const inner = match[2] as string;
            const parts = parseWikilinkInner(inner);
            if (!parts.target && !parts.fragment) return null;
            state.tr.replaceWith(
              range.from,
              range.to,
              this.type.create({ inner, embed: match[1] === "!" }),
            );
          },
        }),
      ];
    },

    addPasteRules() {
      return [
        nodePasteRule({
          find: /(!?)\[\[([^[\]\n]+?)\]\]/g,
          type: this.type,
          getAttributes: (match) => ({ inner: match[2], embed: match[1] === "!" }),
        }),
      ];
    },

    addKeyboardShortcuts() {
      return {
        Backspace: ({ editor }) => {
          const { selection } = editor.state;
          const before = selection.$from.nodeBefore;
          if (!selection.empty || before?.type.name !== this.name) return false;
          const text = source(before.attrs as { inner: string; embed: boolean }).slice(0, -1);
          return editor.commands.insertContentAt(
            { from: selection.from - before.nodeSize, to: selection.from },
            { type: "text", text },
          );
        },
      };
    },

    addProseMirrorPlugins() {
      const name = this.name;
      return [
        new Plugin({
          props: {
            handleClickOn: (_view, _pos, node, _nodePos, event) => {
              if (node.type.name !== name || !(event.metaKey || event.ctrlKey)) return false;
              const ctx = getCtx();
              const parts = parseWikilinkInner(node.attrs.inner as string);
              const path = parts.target && ctx ? ctx.resolve(parts.target) : null;
              if (!ctx || !path) return false;
              ctx.open(path, parts.fragment, event);
              return true;
            },
          },
        }),
      ];
    },
  });
}