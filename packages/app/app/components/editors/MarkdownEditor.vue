<script setup lang="ts">
// Markdown editor with a WYSIWYG mode (tiptap + the official @tiptap/markdown
// serializer) and a byte-faithful source mode (CodeEditor). Styling/toolbar
// mirror the Flux DraftEditor, retargeted to the --th-* tokens.
//
// Fidelity rules (KTD2/KTD3):
//   • The raw markdown string is canonical. We NEVER serialize-on-open — tiptap
//     re-serializes only when the user actually edits in WYSIWYG.
//   • YAML front-matter is peeled off before tiptap sees it and re-attached
//     verbatim on every emit, so the body editor can't corrupt metadata.
import { Icon } from "@iconify/vue";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import IconComment from "~icons/solar/chat-round-line-linear";
import { createWikilinkResolver, dirOf } from "shared";
import { type EditorImageContext, workspaceImage } from "~/utils/editorImage";
import { type EditorWikilinkContext, wikilinkNode } from "~/utils/editorWikilink";
import { joinFrontMatter, splitFrontMatter } from "~/utils/frontmatter";
import { appRouteFor } from "~/utils/markdownRefs";
import { openIntent } from "~/utils/tabs";
import { capturePoint, captureRange } from "~/utils/commentHighlights";
import {
  type AnchorThread,
  anchorAvailability,
  buildDocTextIndex,
  CommentAnchors,
  type EditorCommentDraft,
  spanForDocRange,
  syncCommentAnchors,
} from "./commentAnchors";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    path?: string;
    contentType?: string;
    readonly?: boolean;
    /** Enables display-time resolution of relative image srcs (the stored markdown keeps them). */
    workspaceId?: string;
    /** Threads to paint. Absent (or empty) simply means no comment affordances. */
    threads?: AnchorThread[];
    activeThreadId?: string | null;
    /** Unsaved edits: positions are tracked from the last saved version (KD5). */
    dirty?: boolean;
  }>(),
  {
    path: "",
    contentType: "text/markdown",
    readonly: false,
    workspaceId: undefined,
    threads: () => [],
    activeThreadId: null,
    dirty: false,
  },
);
const emit = defineEmits<{
  "update:modelValue": [value: string];
  save: [];
  "open-thread": [threadId: string];
  "create-comment": [draft: EditorCommentDraft];
}>();

type Mode = "rendered" | "source";
// Mode is a v-model so the parent (FileEditor) can observe it — to hide the
// front-matter fields surface in source mode — and drive it (the "edit in
// source mode" affordance). Defaults to rendered when the parent doesn't bind.
const mode = defineModel<Mode>("mode", { default: "rendered" });
// Same segmented control the top bar uses, so the editor's own view switch
// isn't a second, smaller dialect of the same idea.
const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: "rendered", label: "Rendered" },
  { value: "source", label: "Source" },
];

// Front-matter held verbatim; only the body is handed to tiptap.
const initial = splitFrontMatter(props.modelValue);
let frontMatter = initial.frontMatter;
// The body region currently loaded in tiptap. Lets the external-change watch
// tell a front-matter-only edit (skip the costly setContent reload) apart from
// a real body change (reload).
let lastBody = initial.body;
// The value we last emitted, so an external prop change (reload / file switch)
// can be told apart from our own edit echoing back.
let lastValue = props.modelValue;
// True while we push content into tiptap programmatically, so onUpdate doesn't
// mistake a load for a user edit (the serialize-on-open trap).
let applyingExternal = false;

// Relative image srcs resolve to API file URLs for display only; the document
// attribute (and serialized markdown) keeps the author's path (see editorImage).
const api = useTreehouseApi();
const imageCtx = computed<EditorImageContext | null>(() => {
  const id = props.workspaceId;
  if (!id) return null;
  return {
    docDir: dirOf(props.path),
    fileUrl: (p) => api.fileUrl(id, p),
    filesUrlPrefix: api.fileUrl(id, ""),
  };
});

// [[Wikilinks]] resolve against the files this member can see, like the reading
// view. ⌘/Ctrl-click opens one in a tab (or here, with tabs off); a plain click
// just places the caret, as on any other link while editing.
const wsData = useWorkspaceData();
const tabs = useWorkspaceTabs();
const resolveWikilink = computed(() =>
  createWikilinkResolver(wsData.entries.value.map((e) => e.path)),
);
const wikiCtx = computed<EditorWikilinkContext | null>(() => {
  const id = props.workspaceId;
  if (!id) return null;
  return {
    resolve: resolveWikilink.value,
    open: (path, fragment, event) => {
      const href = `${appRouteFor(id, path)}${fragment ? `#${fragment}` : ""}`;
      if (!tabs.openHref(href, openIntent(event))) void navigateTo(href);
    },
  };
});

const editor = useEditor({
  content: initial.body,
  contentType: "markdown",
  editable: !props.readonly,
  // Opening the editor is a request to type, so put the caret in the document
  // rather than making you click the page you just asked to edit — a new file
  // is empty, and landing on an empty page with no cursor reads as broken.
  // "start", not "end", so a long existing file doesn't jump you to the bottom.
  autofocus: props.readonly ? false : "start",
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        HTMLAttributes: { class: "text-accent underline underline-offset-2" },
      },
    }),
    Markdown,
    workspaceImage(() => imageCtx.value).configure({
      HTMLAttributes: { class: "rounded-lg border border-border max-w-full" },
    }),
    wikilinkNode(() => wikiCtx.value),
    Placeholder.configure({ placeholder: "Start writing…" }),
    Typography,
    CommentAnchors.configure({ onOpen: (id) => emit("open-thread", id) }),
  ],
  // The instance, not `editor.value` — onCreate fires from inside the Editor
  // constructor, before useEditor has assigned the ref.
  onCreate: ({ editor: instance }) => syncAnchors(instance.view),
  onUpdate: () => {
    if (applyingExternal) return;
    emitFromWysiwyg();
  },
});

// --- Comment anchors ------------------------------------------------------
// Threads are matched against the document only while the buffer is CLEAN; once
// it is dirty the decorations ride ProseMirror's position mapping and say so.
// Re-matching a dirty buffer would look smarter and be a lie: the anchor belongs
// to a version, and this text isn't one yet (KD5).
const anchoring = computed(() => anchorAvailability(props.dirty));
const commentsOn = computed(() => !props.readonly && !!props.workspaceId);
// Painting existing threads is a READ, so it survives a billing lock; starting
// a new one is a write and does not. Kept as two flags on purpose — folding the
// lock into `commentsOn` would also blank the decorations, which is the
// opposite of what a locked-but-readable workspace should show.
const billingReadOnly = computed(() => wsData.usage.value?.billing.readOnly === true);
const canStartComment = computed(() => commentsOn.value && !billingReadOnly.value);
const staleNote = computed(() => props.dirty && props.threads.length > 0);

// A signature of everything the decorations depend on. Server state refetches
// land as a NEW array with identical contents several times a session; re-
// dispatching for those would churn ProseMirror's DOM for no visible change.
const anchorSignature = computed(() =>
  [
    props.dirty,
    props.activeThreadId,
    commentsOn.value,
    ...props.threads.map((t) =>
      [t.id, t.status, t.anchorStatus, t.anchorKind, t.currentText ?? t.quote].join(" "),
    ),
  ].join(" | "),
);
let lastSignature: string | null = null;

function syncAnchors(view = editor.value?.view) {
  if (!view) return;
  lastSignature = anchorSignature.value;
  syncCommentAnchors(view, {
    threads: commentsOn.value ? props.threads : [],
    activeId: props.activeThreadId,
    stale: props.dirty,
  });
}

watch(anchorSignature, (sig) => {
  if (sig !== lastSignature) syncAnchors();
});

/**
 * Start a comment on the current selection — a range when there is one, a point
 * at the caret when there isn't. Both are captured from the document text, the
 * same shape the server anchors against.
 */
function startComment() {
  const ed = editor.value;
  if (!ed || !anchoring.value.canCreate) return;
  const index = buildDocTextIndex(ed.state.doc);
  const { from, to } = ed.state.selection;
  const span = spanForDocRange(index, from, to);
  if (span.end > span.start) {
    emit("create-comment", { kind: "range", ...captureRange(index, span) });
  } else {
    emit("create-comment", { kind: "point", quote: "", ...capturePoint(index, span.start) });
  }
}

function emitFromWysiwyg() {
  const ed = editor.value;
  if (!ed) return;
  lastBody = ed.getMarkdown();
  const next = joinFrontMatter(frontMatter, lastBody);
  lastValue = next;
  emit("update:modelValue", next);
}

// Re-parse a canonical markdown string into tiptap without emitting.
function loadIntoWysiwyg(value: string) {
  const split = splitFrontMatter(value);
  frontMatter = split.frontMatter;
  lastBody = split.body;
  lastValue = value;
  const ed = editor.value;
  if (!ed) return;
  applyingExternal = true;
  ed.commands.setContent(split.body, { contentType: "markdown", emitUpdate: false });
  applyingExternal = false;
  // setContent replaces the whole doc, so the mapped decorations are gone —
  // re-match against the document we just loaded.
  syncAnchors();
}

// Source mode edits the full canonical bytes (front-matter included) directly.
function onSourceInput(value: string) {
  const split = splitFrontMatter(value);
  lastValue = value;
  frontMatter = split.frontMatter;
  lastBody = split.body;
  emit("update:modelValue", value);
}

// External value changes (reload / switching files). Ignore our own echo.
watch(
  () => props.modelValue,
  (next) => {
    if (next === lastValue) return;
    if (mode.value === "rendered") {
      // A front-matter-only change (e.g. the fields surface editing metadata)
      // leaves the body identical — update the held front matter in place rather
      // than re-running setContent, which would reset the tiptap doc and cursor.
      const split = splitFrontMatter(next);
      if (editor.value && split.body === lastBody) {
        frontMatter = split.frontMatter;
        lastValue = next;
      } else {
        loadIntoWysiwyg(next);
      }
    } else {
      const split = splitFrontMatter(next);
      lastValue = next;
      frontMatter = split.frontMatter;
      lastBody = split.body;
    }
  },
);

// Returning to WYSIWYG: re-parse the latest canonical value (it may have been
// edited byte-for-byte in source mode).
watch(mode, (m) => {
  if (m === "rendered") loadIntoWysiwyg(props.modelValue);
});

watch(
  () => props.readonly,
  (ro) => editor.value?.setEditable(!ro),
);

// --- Toolbar -------------------------------------------------------------
const ed = editor; // template alias
function active(name: string, attrs?: Record<string, unknown>): boolean {
  return ed.value?.isActive(name, attrs) ?? false;
}
function promptLink() {
  const prev = (ed.value?.getAttributes("link").href as string) ?? "";
  const url = window.prompt("Link URL", prev);
  if (url === null) return;
  if (url === "") ed.value?.chain().focus().extendMarkRange("link").unsetLink().run();
  else ed.value?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}
</script>

<template>
  <div class="markdown-editor flex h-full flex-col">
    <!-- Mode + (rendered-only) formatting toolbar.
         The mode toggle comes FIRST in source order and the format buttons
         scroll, so the toggle can never be the thing pushed off the edge — on a
         phone the whole row overflowed and source view became unreachable while
         editing, which is the one place you most need it. -->
    <div class="flex items-center gap-2 border-b border-border px-2 py-1.5 sm:px-3">
      <div class="order-2 ml-auto shrink-0 lg:order-none">
        <SegmentedControl v-model="mode" :options="MODE_OPTIONS" label="Edit mode" />
      </div>
      <div
        v-if="mode === 'rendered' && !readonly"
        class="order-1 flex min-w-0 items-center gap-0.5 overflow-x-auto lg:order-none"
      >
        <button
          type="button"
          class="tb"
          :class="{ 'tb-on': active('bold') }"
          title="Bold"
          @click="ed?.chain().focus().toggleBold().run()"
        >
          <Icon icon="solar:text-bold-bold" />
        </button>
        <button
          type="button"
          class="tb"
          :class="{ 'tb-on': active('italic') }"
          title="Italic"
          @click="ed?.chain().focus().toggleItalic().run()"
        >
          <Icon icon="solar:text-italic-bold" />
        </button>
        <button
          type="button"
          class="tb"
          :class="{ 'tb-on': active('strike') }"
          title="Strikethrough"
          @click="ed?.chain().focus().toggleStrike().run()"
        >
          <Icon icon="solar:text-cross-bold" />
        </button>
        <button
          type="button"
          class="tb"
          :class="{ 'tb-on': active('code') }"
          title="Inline code"
          @click="ed?.chain().focus().toggleCode().run()"
        >
          <Icon icon="solar:code-bold" />
        </button>
        <span class="divider" />
        <button
          v-for="lvl in [1, 2, 3]"
          :key="lvl"
          type="button"
          class="tb tb-text"
          :class="{ 'tb-on': active('heading', { level: lvl }) }"
          :title="`Heading ${lvl}`"
          @click="
            ed
              ?.chain()
              .focus()
              .toggleHeading({ level: lvl as 1 | 2 | 3 })
              .run()
          "
        >
          H{{ lvl }}
        </button>
        <span class="divider" />
        <button
          type="button"
          class="tb"
          :class="{ 'tb-on': active('bulletList') }"
          title="Bullet list"
          @click="ed?.chain().focus().toggleBulletList().run()"
        >
          <Icon icon="solar:list-bold" />
        </button>
        <button
          type="button"
          class="tb"
          :class="{ 'tb-on': active('orderedList') }"
          title="Numbered list"
          @click="ed?.chain().focus().toggleOrderedList().run()"
        >
          <Icon icon="solar:list-arrow-down-bold" />
        </button>
        <button
          type="button"
          class="tb"
          :class="{ 'tb-on': active('blockquote') }"
          title="Quote"
          @click="ed?.chain().focus().toggleBlockquote().run()"
        >
          <Icon icon="solar:quote-up-bold" />
        </button>
        <button
          type="button"
          class="tb"
          title="Divider"
          @click="ed?.chain().focus().setHorizontalRule().run()"
        >
          <Icon icon="solar:minus-square-bold" />
        </button>
        <button
          type="button"
          class="tb"
          :class="{ 'tb-on': active('link') }"
          title="Link"
          @click="promptLink"
        >
          <Icon icon="solar:link-bold" />
        </button>
        <!-- Comment on the selection (or the caret, for a point). Disabled
             while the buffer is dirty — see the note below the toolbar. -->
        <template v-if="canStartComment">
          <span class="divider" />
          <button
            type="button"
            class="tb"
            :class="{ 'tb-off': !anchoring.canCreate }"
            :disabled="!anchoring.canCreate"
            :title="anchoring.hint"
            @click="startComment"
          >
            <IconComment class="h-3.5 w-3.5" />
          </button>
        </template>
      </div>
    </div>

    <!-- The honest caveat: these highlights are tracking your keystrokes, but
         they were placed against the last saved version and nothing has
         re-anchored them yet. -->
    <p
      v-if="staleNote && mode === 'rendered'"
      class="border-b border-border bg-surface-2/40 px-4 py-1.5 text-xs text-fg-subtle"
    >
      Comment highlights are positioned from the last saved version.
    </p>

    <!-- WYSIWYG (kept mounted via v-show so the editor instance survives) -->
    <div v-show="mode === 'rendered'" class="flex-1 overflow-y-auto">
      <EditorContent :editor="ed" class="prose mx-auto max-w-prose px-6 py-6" />
    </div>

    <!-- Source: edits the exact canonical bytes, front-matter included -->
    <div v-if="mode === 'source'" class="flex-1 overflow-hidden">
      <CodeEditor
        :model-value="modelValue"
        :path="path"
        :content-type="contentType"
        :readonly="readonly"
        @update:model-value="onSourceInput"
        @save="emit('save')"
      />
    </div>
  </div>
</template>

<style scoped>
.tb {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  /* Finger-sized on a phone, unchanged on a pointer device. */
  height: 2.25rem;
  min-width: 2.25rem;
  padding: 0 0.375rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  color: var(--th-fg-muted);
  transition:
    background-color 0.12s,
    color 0.12s;
}
.tb:hover {
  color: var(--th-fg);
  background-color: var(--th-surface-2);
}
.tb-on {
  color: var(--th-fg);
  background-color: var(--th-surface-2);
}
.tb-text {
  font-size: 0.75rem;
  font-weight: 600;
}
.tb-off {
  opacity: 0.4;
  cursor: default;
}
.tb-off:hover {
  color: var(--th-fg-muted);
  background-color: transparent;
}
@media (min-width: 1024px) {
  .tb {
    height: 1.75rem;
    min-width: 1.75rem;
    padding: 0 0.25rem;
  }
}
.divider {
  width: 1px;
  height: 1.25rem;
  margin: 0 0.25rem;
  background-color: var(--th-border);
}
/* Wikilinks read as links, like the reading view's; one that names no file the
   reader can see is muted, matching the viewer's unresolved style. */
.markdown-editor :deep(.wikilink) {
  color: var(--th-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  border-radius: 2px;
  cursor: text;
}
.markdown-editor :deep(.wikilink.ProseMirror-selectednode) {
  outline: 2px solid color-mix(in srgb, var(--th-accent) 45%, transparent);
}
.markdown-editor :deep(.wikilink-unresolved) {
  color: var(--th-fg-subtle);
  text-decoration-style: dotted;
}

/* Drop the browser's default focus ring on the contenteditable surface. */
.markdown-editor :deep(.tiptap) {
  outline: none;
}

/* tiptap wraps every list item's content in a <p>, which the reading view (marked,
   tight lists) does not — so prose's paragraph margins stacked on top of its
   list-item margins and a list opened up the moment you hit Edit. Collapse the
   wrapper paragraph's margins so an edited list has the spacing of the list you
   were just reading; a genuinely multi-paragraph item keeps its gap. */
.markdown-editor :deep(.tiptap li > p) {
  margin-top: 0;
  margin-bottom: 0;
}
.markdown-editor :deep(.tiptap li > p + p) {
  margin-top: 0.75em;
}

/* Comment decorations. Same accent weights as the reading view's highlights, so
   a thread looks like the same thread on both sides of the Edit button — with a
   stale variant that visibly steps back once the buffer has unsaved edits. */
.markdown-editor :deep(.th-comment-mark) {
  background-color: color-mix(in srgb, var(--th-accent) 16%, transparent);
  border-radius: 2px;
  cursor: pointer;
}
.markdown-editor :deep(.th-comment-mark--active) {
  background-color: color-mix(in srgb, var(--th-accent) 34%, transparent);
}
.markdown-editor :deep(.th-comment-mark--stale) {
  background-color: transparent;
  border-radius: 0;
  border-bottom: 1px dashed color-mix(in srgb, var(--th-accent) 55%, transparent);
}
.markdown-editor :deep(.th-comment-pin) {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  margin-right: 0.15rem;
  border-radius: 9999px;
  vertical-align: super;
  cursor: pointer;
  background-color: color-mix(in srgb, var(--th-accent) 45%, transparent);
}
.markdown-editor :deep(.th-comment-pin--active) {
  background-color: var(--th-accent);
}
.markdown-editor :deep(.th-comment-pin--stale) {
  background-color: transparent;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--th-accent) 55%, transparent);
}
</style>