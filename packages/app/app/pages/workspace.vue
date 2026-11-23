<script setup lang="ts">
// Back-compat redirect: /workspace → /w/<id>. Prefer the last workspace the user
// opened (if it's still in their active org) so coming back from the dashboard
// returns there rather than always snapping to the first one.
definePageMeta({ middleware: "auth", layout: "app" });

const api = useTreehouseApi();
const { workspaces } = await api.listWorkspaces();
const last = import.meta.client ? localStorage.getItem(LAST_WS_KEY) : null;
const target = (last && workspaces.some((w) => w.id === last) ? last : workspaces[0]?.id) ?? null;
await navigateTo(target ? `/w/${target}` : "/dashboard", { replace: true });
</script>

<template>
  <div />
</template>