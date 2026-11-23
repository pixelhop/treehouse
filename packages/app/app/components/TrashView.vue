<script setup lang="ts">
import { Icon } from "@iconify/vue";
import { useInfiniteQuery, useQueryClient } from "@tanstack/vue-query";
import type { RecoveryRequest, TrashItem } from "shared";
import { deletedByLabel, trashLabel } from "~/utils/recovery";

// The workspace's trash: every file deleted by a person or an agent, newest
// first, as long as it hasn't been recreated since. Nothing here is stored
// separately — the server reads it off the change feed — and bringing files
// back goes through a preview, then ordinary writes that show in Activity.
const ws = useWorkspaceData();
const api = useTreehouseApi();
const qc = useQueryClient();
const { byId: members } = useWorkspaceMembers(ws.workspaceId);
const session = useAuthClient().useSession();
const userId = computed(() => session.value.data?.user?.id ?? null);

const PAGE = 100;
const query = useInfiniteQuery({
  queryKey: ["trash", ws.workspaceId],
  queryFn: ({ pageParam }) =>
    api.trash(ws.workspaceId.value as string, {
      limit: PAGE,
      ...(pageParam != null ? { before: pageParam } : {}),
    }),
  initialPageParam: null as number | null,
  getNextPageParam: (last) => last.nextBefore,
  enabled: computed(() => !!ws.workspaceId.value),
});
const items = computed<TrashItem[]>(() => query.data.value?.pages.flatMap((p) => p.items) ?? []);

const selected = ref(new Set<string>());
const restorable = computed(() => items.value.filter((i) => i.restorable));
const allSelected = computed(
  () => restorable.value.length > 0 && restorable.value.every((i) => selected.value.has(i.path)),
);
function toggle(path: string) {
  const next = new Set(selected.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  selected.value = next;
}
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(restorable.value.map((i) => i.path));
}

function deletedBy(item: TrashItem): string {
  const member = item.actorId ? members.value.get(item.actorId) : undefined;
  return deletedByLabel(item, userId.value, member?.name ?? null);
}

const request = ref<Extract<RecoveryRequest, { kind: "trash" }> | null>(null);
const dialogTitle = computed(() => {
  const paths = request.value?.paths ?? [];
  return paths.length === 1
    ? `Restore ${trashLabel({ path: paths[0]! }).path}?`
    : `Restore ${paths.length} files?`;
});
function restore(paths: string[]) {
  if (paths.length) request.value = { kind: "trash", paths };
}
function onApplied() {
  selected.value = new Set();
  void qc.invalidateQueries({ queryKey: ["trash"] });
  void qc.invalidateQueries({ queryKey: ["activity"] });
  void qc.invalidateQueries({ queryKey: ["changes"] });
  ws.refresh();
}
</script>

<template>
  <AppTopBar>
    <template #breadcrumb>
      <WorkspaceCrumbs label="Trash" />
    </template>
    <template #actions>
      <button
        v-if="!ws.viewOnly.value"
        type="button"
        class="rounded-md bg-accent px-2.5 py-1.5 font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-40"
        :disabled="selected.size === 0"
        @click="restore([...selected])"
      >
        Restore{{ selected.size ? ` ${selected.size}` : "" }}
      </button>
    </template>
  </AppTopBar>

  <div class="min-h-0 flex-1 overflow-auto bg-app">
    <div class="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-7">
      <p class="mb-4 text-xs text-fg-subtle">
        Files you and your agents delete stay here, with the content they had when they were
        deleted. They don't count toward your storage. Restoring one brings it back where it was.
      </p>

      <div v-if="query.isPending.value" class="rounded-xl border border-border bg-surface p-5">
        <div v-for="n in 4" :key="n" class="mb-3 h-4 w-2/3 animate-pulse rounded bg-surface-2" />
      </div>
      <div
        v-else-if="query.error.value"
        class="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
      >
        Couldn’t load the trash. {{ query.error.value.message }}
      </div>
      <div
        v-else-if="items.length === 0"
        class="rounded-xl border border-border bg-surface px-6 py-16 text-center"
      >
        <Icon
          icon="solar:trash-bin-minimalistic-linear"
          class="mx-auto mb-2 h-6 w-6 text-fg-subtle"
        />
        <p class="text-sm font-medium text-fg">The trash is empty</p>
        <p class="mt-1 text-xs text-fg-subtle">
          Anything deleted from this workspace shows up here.
        </p>
      </div>

      <div v-else class="rounded-xl border border-border bg-surface px-5 py-4">
        <TrashList
          :items="items"
          :selected="selected"
          :all-selected="allSelected"
          :deleted-by="deletedBy"
          :readonly="ws.viewOnly.value"
          @toggle="toggle"
          @toggle-all="toggleAll"
          @restore="(path) => restore([path])"
        />
        <button
          v-if="query.hasNextPage.value"
          type="button"
          class="mt-4 w-full rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted transition hover:bg-surface-2"
          :disabled="query.isFetchingNextPage.value"
          @click="query.fetchNextPage()"
        >
          {{ query.isFetchingNextPage.value ? "Loading…" : "Show older" }}
        </button>
      </div>
    </div>
  </div>

  <RecoveryDialog
    :workspace-id="ws.workspaceId.value ?? ''"
    :request="request"
    :title="dialogTitle"
    done-title="Restored from the trash"
    confirm-label="Restore"
    @close="request = null"
    @applied="onApplied"
  />
</template>