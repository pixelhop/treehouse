<script setup lang="ts">
// Workspace activity feed: /w/<workspaceId>/activity. The static segment wins
// over the [...path] catch-all, so it never resolves as a file path.
definePageMeta({ middleware: "auth", layout: "app" });
</script>

<template>
  <ActivityView />
</template>