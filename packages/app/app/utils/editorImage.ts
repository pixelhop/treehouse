// Display-time image resolution for the Tiptap markdown editor. The stored
// document attribute (and therefore the serialized markdown — @tiptap/markdown
// reads node.attrs.src directly) keeps the author's relative path; only the
// rendered DOM gets the resolved API URL. parseHTML reverse-maps so in-editor
// copy/paste can't leak absolute URLs into the document — it emits the
// root-absolute form (`/docs/x.png`), since the original `./` shape isn't
// recoverable from a URL and a bare relative path would re-resolve against the
// wrong directory.
import Image from "@tiptap/extension-image";
import { resolveRef } from "shared";

export interface EditorImageContext {
  /** Directory of the document being edited ("" at the workspace root). */
  docDir: string;
  /** Builds the raw-bytes URL for a workspace path (api.fileUrl bound to the workspace). */
  fileUrl: (path: string) => string;
  /** The file-bytes URL prefix for this workspace, i.e. fileUrl("") — used to detect our own URLs. */
  filesUrlPrefix: string;
}

/** Stored src → display src. External/unresolvable srcs pass through unchanged. */
export function resolveEditorSrc(src: string, ctx: EditorImageContext): string {
  const ref = resolveRef(ctx.docDir, src);
  return ref.kind === "workspace" ? ctx.fileUrl(ref.path) : src;
}

/** Display src → stored src (root-absolute). Non-workspace URLs pass through unchanged. */
export function unresolveEditorSrc(src: string, ctx: EditorImageContext): string {
  if (!ctx.filesUrlPrefix || !src.startsWith(ctx.filesUrlPrefix)) return src;
  let rest = src.slice(ctx.filesUrlPrefix.length);
  const cut = rest.search(/[?#]/);
  if (cut !== -1) rest = rest.slice(0, cut);
  try {
    // Keep %, # and ? percent-encoded in the stored form: resolveRef splits on
    // literal #/? before decoding, so a filename like "a#b.png" stored decoded
    // would re-resolve to the wrong file ("a") — broken beats wrong-file.
    const segs = rest.split("/").map((s) => {
      const d = decodeURIComponent(s);
      return d.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\?/g, "%3F");
    });
    return `/${segs.join("/")}`;
  } catch {
    return src;
  }
}

/**
 * The Image extension with workspace-aware src mapping. `getCtx` is read lazily
 * so the editor works without a workspace context (srcs render as-authored).
 */
export function workspaceImage(getCtx: () => EditorImageContext | null) {
  return Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        src: {
          default: null,
          parseHTML: (el: HTMLElement) => {
            const src = el.getAttribute("src");
            const ctx = getCtx();
            return src && ctx ? unresolveEditorSrc(src, ctx) : src;
          },
          renderHTML: (attrs: Record<string, unknown>) => {
            const src = attrs.src as string | null;
            const ctx = getCtx();
            return { src: src && ctx ? resolveEditorSrc(src, ctx) : src };
          },
        },
      };
    },
  });
}