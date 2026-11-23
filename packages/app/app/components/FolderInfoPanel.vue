<script setup lang="ts">
import IconCopy from "~icons/solar/copy-linear";
import IconHistory from "~icons/solar/history-linear";
import type { TreeNode } from "~/utils/treehouse";

const props = defineProps<{ folder: TreeNode; workspaceId: string }>();
const viewOnly = useWorkspaceData().viewOnly;
const restoreTo = useRestoreTo();

// Immediate children, ignoring the hidden `.keep` placeholder folders use.
const items = computed(() => props.folder.children.filter((c) => c.name !== ".keep"));
const fileCount = computed(() => items.value.filter((c) => !c.isDir).length);
const folderCount = computed(() => items.value.filter((c) => c.isDir).length);

// "2 files", or "1 folder · 2 files" — an empty count is left out, not shown as 0.
const summary = computed(() => {
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (folderCount.value) parts.push(count(folderCount.value, "folder", "folders"));
  if (fileCount.value || !parts.length) parts.push(count(fileCount.value, "file", "files"));
  return parts.join(" · ");
});

const copied = ref(false);
async function copyPath() {
  try {
    await navigator.clipboard.writeText(props.folder.path);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard can be blocked */
  }
}
</script>

<template>
  <div class="space-y-3">
    <!-- Same header shape as the workspace panel: icon, name, what kind of thing it is.
         ph-mask: user-authored file/folder name; masked in session replay (see app/plugins/posthog.client.ts). -->
    <header class="flex items-center gap-3">
      <span
        class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-base text-fg-muted"
      >
        <NodeIcon :icon="folder.icon" :is-dir="true" class="h-5 w-5" />
      </span>
      <div class="min-w-0">
        <h3 class="ph-mask truncate text-base font-semibold text-fg" :title="folder.name">
          {{ folder.name }}
        </h3>
        <p class="truncate text-xs text-fg-subtle">Folder · {{ summary }}</p>
      </div>
    </header>

    <!-- Plain rows, like a menu: these are occasional actions, and a stack of
         outlined buttons gave them more weight than the sharing below. -->
    <div>
      <button type="button" class="panel-action" @click="copyPath">
        <IconCopy class="h-4 w-4" />
        {{ copied ? "Copied" : "Copy path" }}
      </button>
      <button
        v-if="!viewOnly"
        type="button"
        class="panel-action"
        @click="restoreTo.open(folder.path)"
      >
        <IconHistory class="h-4 w-4" />
        Restore to an earlier time…
      </button>
    </div>

    <!-- Same section heading as the file panel's Metadata and Linked from. -->
    <div v-if="!viewOnly" class="border-t border-border pt-3">
      <h4 class="panel-heading mb-2">Share</h4>
      <FileShare :workspace-id="workspaceId" :path="folder.path" kind="folder" />
    </div>
  </div>
</template>