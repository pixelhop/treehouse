<script setup lang="ts">
// Edit surface for the workspace: routes a file to the markdown or code editor,
// owns the explicit Save (button + ⌘/Ctrl-S), shows dirty/saving state, and
// guards against losing unsaved edits on navigation. Conflict + live-collision
// UI (ConflictBanner) is filled in by U7.
import { onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";
import { useComments, useCommentUi } from "~/composables/useComments";
import type { EditorCommentDraft } from "~/components/editors/commentAnchors";
import { joinFrontMatter, splitFrontMatter } from "~/utils/frontmatter";
import {
  parseFrontMatter,
  serializeFrontMatter,
  type FrontMatterData,
} from "~/utils/frontmatterData";
import { viewerKind } from "~/utils/treehouse";
import { VIEWERS } from "~/utils/viewers";
import type { FileEntry } from "~/composables/useTreehouseApi";

const props = defineProps<{ workspaceId: string; entry: FileEntry }>();
const emit = defineEmits<{ close: [] }>();

const workspaceId = computed(() => props.workspaceId);
const entry = computed(() => props.entry);
const fe = useFileEditor(workspaceId, entry);

const kind = computed(() => VIEWERS[viewerKind(props.entry.contentType, props.entry.path)].editor);

// WYSIWYG vs source sub-mode, lifted out of MarkdownEditor so the front-matter
// fields surface can hide in source mode and the "edit in source mode"
// affordance can switch to it.
const editorMode = ref<"rendered" | "source">("rendered");

// Comments follow the file into edit mode (R1). Same query key as the reading
// view and the panel, so the highlights, the badge and the thread list are one
// list — and the interaction state is the shared one, so the thread focused
// before hitting Edit is still focused after.
const commentUi = useCommentUi();
const commentWorkspaceId = computed<string | undefined>(() => props.workspaceId);
const commentPath = computed<string | undefined>(() =>
  kind.value === "markdown" ? props.entry.path : undefined,
);
const comments = useComments(commentWorkspaceId, commentPath);
// A save mints a new version, and the server re-resolves every anchor against
// it. Pull the fresh `currentText` so the highlights re-place on the saved doc
// rather than on whatever they were tracking a keystroke ago.
watch(
  () => fe.loadedVersion.value,
  () => void comments.refresh(),
);

// The version the buffer was loaded at is the version a new comment is pinned
// to — and creation is refused while dirty, so it is always the right one.
function startComment(draft: EditorCommentDraft) {
  if (fe.loadedVersion.value === null) return;
  commentUi.startDraft({
    path: props.entry.path,
    baseVersion: fe.loadedVersion.value,
    ...draft,
  });
}

// Front matter derived live from the canonical buffer. The fields surface edits
// only the front-matter region; the body stays owned by MarkdownEditor.
const fmSplit = computed(() => splitFrontMatter(fe.buffer.value));
const fmData = computed(() =>
  fmSplit.value.frontMatter ? parseFrontMatter(fmSplit.value.frontMatter) : null,
);
const fmUnparsed = computed(() => fmSplit.value.frontMatter !== "" && fmData.value === null);

// Reformat-on-edit: re-serialize the whole block and rejoin it to the *current*
// body (re-split so a concurrent body edit is not clobbered). This is the only
// new write path, so an untouched file's front matter is never reformatted (R8).
function onFrontMatterUpdate(next: FrontMatterData) {
  const body = splitFrontMatter(fe.buffer.value).body;
  fe.buffer.value = joinFrontMatter(serializeFrontMatter(next), body);
}

async function save() {
  if (!fe.dirty.value || fe.saving.value) return;
  await fe.save();
}

function confirmDiscard(): boolean {
  return !fe.dirty.value || window.confirm("Discard unsaved changes?");
}

function close() {
  if (confirmDiscard()) emit("close");
}

// Reloading from the banner replaces the buffer with server bytes — confirm
// first if there are unsaved local edits to discard.
function reloadGuarded() {
  if (confirmDiscard()) void fe.reload();
}

// ⌘/Ctrl-S saves from anywhere in the edit pane (covers WYSIWYG, where tiptap
// doesn't intercept the key; the code editor also emits its own save event).
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void save();
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

// Warn before a browser close/refresh drops unsaved edits.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (fe.dirty.value) e.preventDefault();
}
onMounted(() => window.addEventListener("beforeunload", onBeforeUnload));
onBeforeUnmount(() => window.removeEventListener("beforeunload", onBeforeUnload));

// The tab row marks the active tab while it holds unsaved edits.
const editorDirty = useState<boolean>(EDITOR_DIRTY_KEY, () => false);
watch(
  () => fe.dirty.value,
  (dirty) => (editorDirty.value = dirty),
  { immediate: true },
);
onBeforeUnmount(() => (editorDirty.value = false));

// In-app navigation: switching files (param change) or leaving the workspace.
// A tab switch is a navigation too, so this is also what stops one from
// dropping an unsaved edit.
onBeforeRouteUpdate(() => confirmDiscard());
onBeforeRouteLeave(() => confirmDiscard());
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Edit toolbar -->
    <div class="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
      <span class="ph-mask min-w-0 truncate text-sm font-medium text-fg">{{ entry.path }}</span>
      <span
        v-if="fe.dirty.value"
        class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        title="Unsaved changes"
      />
      <span v-if="fe.saving.value" class="text-xs text-fg-subtle">Saving…</span>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-50"
          :disabled="!fe.dirty.value || fe.saving.value"
          @click="save"
        >
          Save
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm text-fg-muted transition hover:bg-surface-2"
          @click="close"
        >
          Done
        </button>
      </div>
    </div>

    <ConflictBanner
      v-if="fe.conflict.value || fe.serverChanged.value"
      :conflict="fe.conflict.value"
      :server-changed="fe.serverChanged.value"
      @reload="reloadGuarded()"
      @dismiss="fe.dismiss()"
    />

    <div
      v-if="fe.error.value"
      class="border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger"
    >
      {{ fe.error.value }}
    </div>

    <!-- Editor body -->
    <!-- ph-no-capture: session replay renders this as a grey box. This is the
         user's file CONTENTS, live and mid-edit. See app/plugins/posthog.client.ts. -->
    <div class="ph-no-capture min-h-0 flex-1">
      <!-- Where the editor's text will start: below its toolbar, in its column. -->
      <FileLoading v-if="fe.loading.value" class="mx-auto max-w-prose px-6 pt-16" />
      <div v-else-if="kind === 'markdown'" class="flex h-full flex-col">
        <FrontMatterFields
          v-if="editorMode === 'rendered' && fmData"
          :data="fmData"
          class="max-h-[40%] shrink-0 overflow-y-auto"
          @update:data="onFrontMatterUpdate"
          @edit-source="editorMode = 'source'"
        />
        <p
          v-else-if="editorMode === 'rendered' && fmUnparsed"
          class="shrink-0 border-b border-border bg-surface-2/40 px-6 py-3 text-xs text-fg-subtle"
        >
          Front matter couldn't be parsed —
          <button type="button" class="text-accent hover:underline" @click="editorMode = 'source'">
            edit in source mode</button
          >.
        </p>
        <MarkdownEditor
          v-model="fe.buffer.value"
          v-model:mode="editorMode"
          :path="entry.path"
          :content-type="entry.contentType"
          :workspace-id="workspaceId"
          :threads="comments.threads.value"
          :active-thread-id="commentUi.activeThreadId.value"
          :dirty="fe.dirty.value"
          class="min-h-0 flex-1"
          @save="save"
          @open-thread="commentUi.focusThread($event)"
          @create-comment="startComment"
        />
      </div>
      <CodeEditor
        v-else-if="kind === 'code'"
        v-model="fe.buffer.value"
        :path="entry.path"
        :content-type="entry.contentType"
        @save="save"
      />
    </div>
  </div>
</template>