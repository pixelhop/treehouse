<script setup lang="ts">
// Public read-only viewer for a shared file or folder. No auth middleware —
// access is the token (plus optional password). ShareView renders the whole
// shell (it applies the workspace's theme itself), so no layout wraps it.
definePageMeta({ layout: false });

const route = useRoute();
const token = computed(() => String(route.params.token ?? ""));
</script>

<template>
  <ShareView :token="token" />
</template>