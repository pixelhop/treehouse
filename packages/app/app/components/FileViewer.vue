<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import type { FileSource } from "~/utils/fileSource";
import type { HtmlRefContext } from "~/utils/htmlRefs";
import type { RefRewriteContext } from "~/utils/markdownRefs";
import { createWikilinkResolver, dirOf } from "shared";
import { viewerKind, type ViewerKind } from "~/utils/treehouse";
import { fillsCanvas, VIEWERS } from "~/utils/viewers";
import type { FileEntry } from "~/composables/useTreehouseApi";

// `fileSource` is where the bytes come from and how other files are addressed —
// the workspace API in the app, the share API on a public link. See
// utils/fileSource.ts.
const props = withDefaults(
  defineProps<{
    fileSource: FileSource;
    entry: FileEntry | null;
    mode?: "rendered" | "source";
    kind?: ViewerKind | null;
    /**
     * Opt in to the comment overlay, by workspace id (KD7 — comments are for
     * members only). Absent on a public share, which renders the bare viewer.
     * Deliberately NOT derived from `fileSource.key`: that key is a share token
     * on a public link, so inferring a workspace id from it would put member
     * review threads on a client-facing page.
     */
    commentsWorkspaceId?: string | null;
    /** Opt-in: run an HTML file's own scripts (see viewers/HtmlViewer.vue). */
    htmlScripts?: boolean;
  }>(),
  { mode: "rendered", kind: null, commentsWorkspaceId: null, htmlScripts: false },
);

// Media is loaded by the browser from a URL, not through `readText`, so its
// failures never reach the query above. Surfacing them lets a caller react —
// the public share viewer re-checks whether its unlock cookie has expired.
const emit = defineEmits<{ mediaError: [] }>();

// Resolved by the parent (WorkspaceView) for the top-bar toggle; fall back to
// computing it here so the component works standalone.
const kind = computed(
  () =>
    props.kind ?? (props.entry ? viewerKind(props.entry.contentType, props.entry.path) : "binary"),
);

// Which component renders this kind, and what it needs: utils/viewers.ts.
const viewer = computed(() => VIEWERS[kind.value]);
// Only text-shaped kinds need the file body fetched; image/binary use the URL.
const needsBody = computed(() => viewer.value.needsBody);

// Cache file bytes by [source, path, version]. A file's content is immutable
// for a given version, so staleTime is Infinity — re-opening a seen file (even
// after reload, via the persisted cache) is instant with no refetch.
const contentQuery = useQuery({
  queryKey: computed(() => ["file", props.fileSource.key, props.entry?.path, props.entry?.version]),
  queryFn: () => props.fileSource.readText(props.entry!.path),
  enabled: computed(() => !!props.entry && needsBody.value),
  staleTime: Number.POSITIVE_INFINITY,
  // A new version of the file already on screen (someone saved, an agent wrote)
  // keeps showing the old text until the new text lands, instead of blanking
  // the page to a loading state for every live update. Only for the SAME file
  // from the same source: another file's text must never stand in for this one.
  placeholderData: (previous, previousQuery) =>
    previousQuery?.queryKey[1] === props.fileSource.key &&
    previousQuery?.queryKey[2] === props.entry?.path
      ? previous
      : undefined,
});

// How relative references inside a document resolve: media to the raw bytes,
// links to the page that displays the target file. A source that can't reach
// sibling files resolves neither (see FileSource.reachesSiblings) — media stays
// as authored and links are defused, rather than both pointing at the one file
// the source does serve.
const docDir = computed(() => (props.entry ? dirOf(props.entry.path) : ""));
// Built once per file list rather than per render: it indexes every path.
const resolveWikilink = computed(() => {
  const paths = props.fileSource.paths?.();
  return paths ? createWikilinkResolver(paths) : null;
});
const markdownRefs = computed<RefRewriteContext | null>(() =>
  props.entry
    ? {
        docDir: docDir.value,
        fileUrl: props.fileSource.reachesSiblings ? (p) => props.fileSource.fileUrl(p) : null,
        pageUrl: props.fileSource.reachesSiblings ? (p) => props.fileSource.pageUrl(p) : null,
        resolveWikilink: resolveWikilink.value,
      }
    : null,
);
// The HTML preview frame is sandboxed and can't run the SPA itself, so its
// links open in the top window (see utils/htmlRefs.ts).
const htmlRefs = computed<HtmlRefContext | null>(() =>
  markdownRefs.value
    ? { ...markdownRefs.value, origin: import.meta.client ? window.location.origin : "" }
    : null,
);

const content = computed(() => contentQuery.data.value ?? "");
const loading = computed(() => contentQuery.isPending.value && needsBody.value);
// A full-bleed page has no reading column around it, so the placeholder brings
// its own — the same one the column gives every other document.
const loadingInset = computed(() => fillsCanvas(kind.value, props.mode));
const error = computed(() => (contentQuery.error.value as Error | null)?.message ?? null);

const view = computed(() =>
  props.entry
    ? viewer.value.render({
        entry: props.entry,
        fileSource: props.fileSource,
        content: content.value,
        mode: props.mode,
        markdownRefs: markdownRefs.value,
        htmlRefs: htmlRefs.value,
        htmlScripts: props.htmlScripts,
        commentsWorkspaceId: props.commentsWorkspaceId,
        onMediaError: () => emit("mediaError"),
      })
    : null,
);
</script>

<template>
  <div v-if="!entry" class="flex h-full items-center justify-center text-sm text-fg-subtle">
    Select a file to view.
  </div>
  <!-- ph-no-capture: session replay renders this whole region as a grey box.
       It is the single chokepoint through which every file's CONTENTS reach the
       screen, so blocking it here blocks every viewer in utils/viewers.ts at
       once. See app/plugins/posthog.client.ts. -->
  <div v-else class="ph-no-capture flex h-full flex-col gap-3">
    <FileLoading
      v-if="loading"
      :class="loadingInset ? 'mx-auto max-w-3xl px-4 pt-6 sm:px-8 sm:pt-8' : ''"
    />
    <div v-else-if="error" class="text-sm text-danger">Failed to load: {{ error }}</div>

    <!-- Each kind's component and props come from its registry entry
         (utils/viewers.ts) and load on demand. Markdown renders through the
         comment wrapper only when a caller opts in with a workspace id; a
         public share passes none and gets the bare viewer (KD7). -->
    <component :is="view.component" v-else-if="view" v-bind="view.props" />
  </div>
</template>