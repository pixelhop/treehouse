<script setup lang="ts">
// `useQueryClient` is not auto-imported by the vue-query module — a clean
// typecheck does not prove it resolves at runtime.
import { useQueryClient } from "@tanstack/vue-query";

// Workspace overview: /w/<workspaceId>
definePageMeta({ middleware: "auth", layout: "app" });

// Returning from Stripe checkout.
//
// The usage query carries the plan's limits and is both long-lived
// (staleTime 5min) and persisted to IndexedDB, so without this a customer who
// has just paid keeps seeing their OLD plan's numbers — across reloads — until
// the entry goes stale. Paying and watching nothing change is the worst possible
// moment for a stale cache.
//
// The marker is dropped from the URL afterwards so a refresh does not re-trigger.
const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

onMounted(async () => {
  if (!route.query.upgraded) return;
  await qc.invalidateQueries({ queryKey: ["usage"] });
  await router.replace({ query: { ...route.query, upgraded: undefined } });
});
</script>

<template>
  <WorkspaceView />
</template>