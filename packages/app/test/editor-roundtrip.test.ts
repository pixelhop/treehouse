// Headless Tiptap round-trip for the R5/R9 invariant: the editor displays
// relative images via a resolved API URL, but load → serialize must keep the
// stored markdown byte-identical. Guards against a Tiptap/@tiptap/markdown
// upgrade switching serialization from node.attrs.src to the rendered DOM src.
import { Window } from "happy-dom";
import { describe, expect, it } from "vite-plus/test";

const win = new Window();
const globals: Record<string, unknown> = globalThis as Record<string, unknown>;
for (const key of [
  "document",
  "navigator",
  "MutationObserver",
  "DOMParser",
  "Element",
  "HTMLElement",
  "Node",
  "Text",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "KeyboardEvent",
  "MouseEvent",
  "InputEvent",
  "CustomEvent",
  "Range",
  "XMLSerializer",
]) {
  if (!(key in globalThis)) globals[key] = (win as unknown as Record<string, unknown>)[key];
}
globals.window = win;
globals.document = win.document;

import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { workspaceImage } from "../app/utils/editorImage";
import { wikilinkNode } from "../app/utils/editorWikilink";

const ctx = {
  docDir: "docs",
  fileUrl: (p: string) =>
    `https://api.test/api/workspaces/ws1/files/${p.split("/").map(encodeURIComponent).join("/")}`,
  filesUrlPrefix: "https://api.test/api/workspaces/ws1/files/",
};

function makeEditor(body: string) {
  return new Editor({
    element: win.document.createElement("div") as unknown as HTMLElement,
    content: body,
    contentType: "markdown",
    extensions: [
      StarterKit,
      Markdown,
      workspaceImage(() => ctx),
      wikilinkNode(() => ({
        resolve: (t: string) => (t.toLowerCase() === "note" ? "docs/Note.md" : null),
        open: () => {},
      })),
    ],
  });
}

describe("editor markdown round-trip (AE6)", () => {
  it("keeps a relative image src byte-identical through load -> serialize", () => {
    const body = "before\n\n![shot](./shot.png)\n\nafter";
    const editor = makeEditor(body);
    expect(editor.getMarkdown()).toBe(body);
    editor.destroy();
  });

  it("renders the resolved API URL in the editor DOM while storing the relative path", () => {
    const editor = makeEditor("![shot](./shot.png)");
    expect(editor.getHTML()).toContain("https://api.test/api/workspaces/ws1/files/docs/shot.png");
    expect(editor.getMarkdown()).toBe("![shot](./shot.png)");
    editor.destroy();
  });

  it("leaves external and unresolvable srcs untouched in both layers", () => {
    const body = "![a](https://x.com/a.png)\n\n![b](../../escape.png)";
    const editor = makeEditor(body);
    expect(editor.getMarkdown()).toBe(body);
    expect(editor.getHTML()).toContain("https://x.com/a.png");
    expect(editor.getHTML()).toContain("../../escape.png");
    editor.destroy();
  });
});

describe("editor wikilink round-trip", () => {
  it("keeps every wikilink form byte-identical through load -> serialize", () => {
    const body = [
      "Plain [[Note]], aliased [[Note|the note]], deep [[Note#Plan|plan]].",
      "",
      "Embedded ![[Diagram.png]] and same-note [[#Top]].",
      "",
      "- [[ Spaced Name ]] in a list",
      "- table-style [[Note\\|short]] escape",
    ].join("\n");
    const editor = makeEditor(body);
    expect(editor.getMarkdown()).toBe(body);
    editor.destroy();
  });

  it("shows the alias and marks unresolved links in the editor DOM", () => {
    const editor = makeEditor("[[Note|the note]] [[Ghost]]");
    const html = editor.getHTML();
    expect(html).toContain(">the note</span>");
    expect(html).toMatch(/class="wikilink wikilink-unresolved"[^>]*>Ghost</);
    editor.destroy();
  });

  it("serializes text typed around a wikilink without escaping it", () => {
    const editor = makeEditor("[[Note]]");
    editor.commands.focus("end");
    editor.commands.insertContent(" and more");
    expect(editor.getMarkdown()).toBe("[[Note]] and more");
    editor.destroy();
  });

  it("turns typed [[…]] into a link", () => {
    const editor = makeEditor("x");
    editor.commands.focus("end");
    // Input rules fire on typed text; simulate typing the closing bracket.
    editor.commands.insertContent(" [[Other|o]");
    const { view } = editor;
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, "]", () => view.state.tr),
    );
    expect(handled).toBe(true);
    expect(editor.getMarkdown()).toBe("x [[Other|o]]");
    expect(editor.getJSON().content?.[0]?.content?.some((n) => n.type === "wikilink")).toBe(true);
    editor.destroy();
  });
});