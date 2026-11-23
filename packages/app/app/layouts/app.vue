<script setup lang="ts">
// Signed-in app shell. The frame itself lives in AppShell (shared with the
// public share viewer); this layout supplies the workspace sidebar, the tab row
// above the page (hidden unless tabs are on and a second one is open), and theme.
//
// Apply the active workspace's effective theme (personal override → workspace
// default → light) whenever it changes.
const theme = useTheme();
watch(theme.effective, (eff) => applyTheme(eff), { immediate: true, deep: true });
</script>

<template>
  <AppShell>
    <template #sidebar>
      <AppSidebar />
    </template>
    <WorkspaceTabs />
    <slot />
    <RestoreToDialog />
  </AppShell>
</template>