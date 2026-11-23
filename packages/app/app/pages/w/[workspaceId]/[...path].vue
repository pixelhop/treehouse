<script setup lang="ts">
// A file or folder within a workspace: /w/<workspaceId>/<path...>
definePageMeta({ middleware: "auth", layout: "app" });
</script>

<template>
  <WorkspaceView />
</template>