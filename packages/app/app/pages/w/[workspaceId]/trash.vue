<script setup lang="ts">
// Workspace trash: /w/<workspaceId>/trash. The static segment wins over the
// [...path] catch-all, so it never resolves as a file path.
definePageMeta({ middleware: "auth", layout: "app" });
</script>

<template>
  <TrashView />
</template>