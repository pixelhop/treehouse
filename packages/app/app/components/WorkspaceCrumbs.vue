<script setup lang="ts">
// "<workspace> / <page>" for a workspace-level page's top bar (Activity, Trash).
defineProps<{ label: string }>();
const ws = useWorkspaceData();
</script>

<template>
  <NuxtLink
    v-if="ws.workspaceId.value"
    :to="`/w/${ws.workspaceId.value}`"
    class="shrink-0 truncate rounded px-1.5 py-1 text-fg-muted no-underline transition hover:bg-surface-2"
  >
    {{ ws.workspace.value?.name ?? "Workspace" }}
  </NuxtLink>
  <span class="shrink-0 text-fg-subtle">/</span>
  <span class="shrink-0 px-1.5 py-1 font-medium text-fg">{{ label }}</span>
</template>