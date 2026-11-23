// The viewer registry: one entry per viewer kind, saying which component renders
// it, what it needs from the file, and how the chrome around it treats it.
//
// Every surface that branches on a file's kind — FileViewer, the workspace and
// share views, the info panel, the editor — reads this table rather than keeping
// its own list of kinds. Adding a viewer is one entry here plus its
// classification in `viewerKind` (packages/shared). The table is a
// `Record<ViewerKind, …>`, so a kind without an entry fails the typecheck
// instead of quietly falling through somebody's `v-if` chain.
//
// Components load on demand. Opening an image doesn't download the markdown,
// HTML or code renderers, and a public share pays only for the kind it shows.
// The imports are relative rather than `~/` so the table also loads under
// vitest, which doesn't know Nuxt's aliases.
import { defineAsyncComponent, h, type Component } from "vue";
import type { ViewerKind } from "shared";
import type { FileEntry } from "../composables/useTreehouseApi";
import type { FileSource } from "./fileSource";
import type { HtmlRefContext } from "./htmlRefs";
import type { RefRewriteContext } from "./markdownRefs";

/** Which editor a file opens in, or null when it isn't editable (media/binary). */
export type EditorKind = "markdown" | "code";

export type ViewerMode = "rendered" | "source";

/** Everything FileViewer knows about the file on screen, for an entry to pick from. */
export interface ViewerContext {
  entry: FileEntry;
  fileSource: FileSource;
  /** The file's text. Empty for kinds that don't fetch it (`needsBody: false`). */
  content: string;
  mode: ViewerMode;
  markdownRefs: RefRewriteContext | null;
  htmlRefs: HtmlRefContext | null;
  htmlScripts: boolean;
  /** The comment overlay's opt-in (KD7). Null on a public share. */
  commentsWorkspaceId: string | null;
  /** A media load failed: the share view re-checks its unlock cookie. */
  onMediaError: () => void;
}

export interface ViewerDef {
  /** Fetch the file's text before rendering. Media kinds load from a URL instead. */
  needsBody: boolean;
  /** Offers a rendered ⇄ source toggle in the top bar. */
  sourceToggle: boolean;
  /** Takes the whole canvas, edge to edge, when rendered. Source view stays in the reading column. */
  fullBleed: boolean;
  /** The edit surface this kind opens in, or null when it's read-only. */
  editor: EditorKind | null;
  /** The component to mount and the props (and listeners) to give it. */
  render: (ctx: ViewerContext) => { component: Component; props: Record<string, unknown> };
  /**
   * Start downloading this kind's viewer code without mounting it, so a file
   * opened after a hover finds its renderer already here. The bundler hands the
   * async component the same module promise, so nothing is fetched twice.
   */
  preload: () => Promise<unknown>;
}

// Shown only if a viewer's chunk takes longer than `delay` to arrive, so a
// cached or fast load never flashes it. The same placeholder FileViewer shows
// while the text loads, so a slow file reads as one wait, not two different
// ones; no delay of its own, since the async component already waited. Loaded
// rather than imported so this table still loads under vitest, which compiles
// no .vue files here; FileViewer imports it anyway, so it is already present.
const FileLoading = defineAsyncComponent(() => import("../components/FileLoading.vue"));
const ViewerLoading = () => h(FileLoading, { delay: 0 });
// A chunk that fails to load is almost always a deploy that replaced it under an
// open tab. A reload picks up the new build.
const ViewerFailed = () =>
  h(
    "div",
    { class: "text-sm text-danger" },
    "Couldn’t load this viewer. Reload the page to try again.",
  );

function lazy(loader: () => Promise<Component | { default: Component }>): Component {
  return defineAsyncComponent({
    loader,
    loadingComponent: ViewerLoading,
    errorComponent: ViewerFailed,
    delay: 200,
  });
}

// Loaders are named so `preload` can start the same import the component will
// make, ahead of time.
const loadMarkdown = () => import("../components/viewers/MarkdownViewer.vue");
const loadCommentedMarkdown = () => import("../components/CommentedMarkdownViewer.vue");
const loadHtml = () => import("../components/viewers/HtmlViewer.vue");
const loadCode = () => import("../components/viewers/CodeViewer.vue");
const loadImage = () => import("../components/viewers/ImageViewer.vue");
const loadBinary = () => import("../components/viewers/BinaryViewer.vue");
const loadMedia = () => import("../components/viewers/MediaViewer.vue");

const MarkdownViewer = lazy(loadMarkdown);
// Comment UI lives in a wrapper AROUND MarkdownViewer, never inside it, so the
// bare viewer stays free of comment code (see test/commentHighlights.test.ts).
const CommentedMarkdownViewer = lazy(loadCommentedMarkdown);
const HtmlViewer = lazy(loadHtml);
const CodeViewer = lazy(loadCode);
const ImageViewer = lazy(loadImage);
const BinaryViewer = lazy(loadBinary);
/** Video and audio share one player component; the version sheet mounts it too. */
export const MediaViewer = lazy(loadMedia);

// The browser plays media from the file's URL, asking for byte ranges as it
// seeks, so neither kind fetches a body.
function media(kind: "video" | "audio"): ViewerDef {
  return {
    needsBody: false,
    sourceToggle: false,
    fullBleed: false,
    editor: null,
    preload: loadMedia,
    render: (ctx) => ({
      component: MediaViewer,
      props: {
        kind,
        src: ctx.fileSource.fileUrl(ctx.entry.path),
        downloadHref: ctx.fileSource.downloadUrl(ctx.entry.path),
        name: ctx.entry.path,
        size: ctx.entry.size,
        onError: ctx.onMediaError,
      },
    }),
  };
}

export const VIEWERS: Record<ViewerKind, ViewerDef> = {
  markdown: {
    needsBody: true,
    sourceToggle: true,
    fullBleed: false,
    editor: "markdown",
    // The member's view: the comment wrapper, which pulls in the bare viewer.
    preload: loadCommentedMarkdown,
    // The overlay only when a caller opts in with a workspace id. A public share
    // passes none and gets the bare viewer, with no comment UI and no comment
    // requests (KD7).
    render: (ctx) =>
      ctx.commentsWorkspaceId
        ? {
            component: CommentedMarkdownViewer,
            props: {
              source: ctx.content,
              mode: ctx.mode,
              workspaceId: ctx.commentsWorkspaceId,
              path: ctx.entry.path,
              version: ctx.entry.version,
              refs: ctx.markdownRefs,
            },
          }
        : {
            component: MarkdownViewer,
            props: { source: ctx.content, mode: ctx.mode, refs: ctx.markdownRefs },
          },
  },
  html: {
    needsBody: true,
    sourceToggle: true,
    // Pages lay themselves out edge to edge, as they would in their own tab.
    fullBleed: true,
    editor: "code",
    preload: loadHtml,
    render: (ctx) => ({
      component: HtmlViewer,
      props: { source: ctx.content, mode: ctx.mode, refs: ctx.htmlRefs, scripts: ctx.htmlScripts },
    }),
  },
  text: {
    needsBody: true,
    sourceToggle: false,
    fullBleed: false,
    editor: "code",
    preload: loadCode,
    render: (ctx) => ({
      component: CodeViewer,
      props: { source: ctx.content, path: ctx.entry.path, contentType: ctx.entry.contentType },
    }),
  },
  image: {
    needsBody: false,
    sourceToggle: false,
    fullBleed: false,
    editor: null,
    preload: loadImage,
    render: (ctx) => ({
      component: ImageViewer,
      props: {
        src: ctx.fileSource.fileUrl(ctx.entry.path),
        name: ctx.entry.path,
        onError: ctx.onMediaError,
      },
    }),
  },
  video: media("video"),
  audio: media("audio"),
  binary: {
    needsBody: false,
    sourceToggle: false,
    fullBleed: false,
    editor: null,
    preload: loadBinary,
    render: (ctx) => ({
      component: BinaryViewer,
      props: {
        href: ctx.fileSource.fileUrl(ctx.entry.path),
        name: ctx.entry.path,
        size: ctx.entry.size,
      },
    }),
  },
};

/**
 * Whether a file of this kind takes the whole canvas. Null (nothing open)
 * never does, and neither does source view: code reads best in the column.
 */
export function fillsCanvas(kind: ViewerKind | null, mode: ViewerMode = "rendered"): boolean {
  return !!kind && mode === "rendered" && VIEWERS[kind].fullBleed;
}