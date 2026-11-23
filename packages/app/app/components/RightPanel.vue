<script setup lang="ts">
import type {
  FileEntry,
  WorkspaceInfo as Workspace,
  WorkspaceUsage,
} from "~/composables/useTreehouseApi";
import type { TreeNode } from "~/utils/treehouse";

defineProps<{
  workspace: Workspace;
  entry: FileEntry | null;
  folder: TreeNode | null;
  fileCount: number;
  usage: WorkspaceUsage | null;
}>();
</script>

<template>
  <!-- File selected → info/history/share tabs. Folder selected → folder info + share. -->
  <div v-if="entry">
    <FileInfoPanel :entry="entry" :workspace-id="workspace.id" />
  </div>
  <div v-else-if="folder">
    <FolderInfoPanel :folder="folder" :workspace-id="workspace.id" />
  </div>
  <div v-else>
    <WorkspaceInfo
      :name="workspace.name"
      :workspace-id="workspace.id"
      :icon="workspace.icon"
      :color="workspace.color"
      :file-count="fileCount"
      :usage="usage"
    />
  </div>
</template>