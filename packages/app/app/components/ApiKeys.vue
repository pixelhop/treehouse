<script setup lang="ts">
import { collectFolderPaths } from "~/utils/treehouse";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { ApiKeyInfo } from "~/composables/useTreehouseApi";
import { ACTIVE_WS_KEY } from "~/utils/workspaceState";

const api = useTreehouseApi();
const qc = useQueryClient();
const {
  public: { apiUrl },
} = useRuntimeConfig();
const mcpUrl = `${apiUrl as string}/api/mcp`;
// Agents connect over OAuth: no key in the command, the agent opens a browser
// for the user to sign in and name the connection.
const oauthSnippet = `claude mcp add --transport http treehouse ${mcpUrl}`;

const name = ref("");
const actorType = ref<"agent" | "human">("agent");
const activeWorkspaceId = useState<string | null>(ACTIVE_WS_KEY, () => null);
const keyAccess = ref<"write" | "read">("write");
// Keys here have always reached every workspace, so that stays the default.
const keyReach = ref<string | null>(null);
const errorMsg = ref<string | null>(null);

// The plaintext key + its setup snippets, shown exactly once after creation.
const justCreated = ref<{ key: string; name: string; actorType: string } | null>(null);

const keysQuery = useQuery({
  queryKey: ["keys"],
  queryFn: () => api.listKeys().then((r) => r.keys),
});
// User-scoped keys reach every workspace the user is a member of.
const keys = computed(() => keysQuery.data.value ?? []);
const loading = computed(() => keysQuery.isPending.value);
const error = computed(
  () => errorMsg.value ?? (keysQuery.error.value as Error | null)?.message ?? null,
);

// What the picker says must be what gets minted: anything but "All your
// workspaces" locks the key to the workspace that's open.
function reachOf(reach: string | null) {
  if (reach === null) return {};
  const workspaceId = activeWorkspaceId.value ?? undefined;
  return reach ? { workspaceId, folder: reach } : { workspaceId };
}

const createMutation = useMutation({
  mutationFn: () =>
    api.createKey(name.value.trim() || "treehouse-key", actorType.value, {
      access: keyAccess.value,
      ...reachOf(keyReach.value),
    }),
  onSuccess: (created) => {
    justCreated.value = { key: created.key, name: created.name, actorType: created.actorType };
    name.value = "";
    keyAccess.value = "write";
    keyReach.value = null;
    void qc.invalidateQueries({ queryKey: ["keys"] });
  },
  onError: (e) => {
    errorMsg.value = (e as Error).message;
  },
});
const creating = computed(() => createMutation.isPending.value);
function create() {
  errorMsg.value = null;
  createMutation.mutate();
}

// "Undo changes…" opens the undo dialog for this key in the workspace that's
// open. Keys scoped to another workspace have nothing here to undo.
const emit = defineEmits<{ undo: [] }>();
const restoreTo = useRestoreTo();
const ws = useWorkspaceData();
const viewOnly = ws.viewOnly;
const workspaceFolders = computed(() => collectFolderPaths(ws.tree.value).sort());
// A read-only key has changed nothing, so there's nothing of its to undo.
const keyCouldWrite = (k: ApiKeyInfo) => k.metadata?.scope?.access !== "read";
const keyReachesHere = (k: ApiKeyInfo) =>
  !k.metadata?.workspaceId || k.metadata.workspaceId === activeWorkspaceId.value;
function canUndo(k: ApiKeyInfo) {
  return !viewOnly.value && keyCouldWrite(k) && keyReachesHere(k);
}
function undo(k: ApiKeyInfo) {
  emit("undo");
  restoreTo.openUndo(k.id, k.name ?? "this key", new Date(Date.now() - 60 * 60_000));
}

const revokeMutation = useMutation({
  mutationFn: (id: string) => api.revokeKey(id),
  onSuccess: () => qc.invalidateQueries({ queryKey: ["keys"] }),
  onError: (e) => {
    errorMsg.value = (e as Error).message;
  },
});
function revoke(id: string) {
  if (!confirm("Revoke this key? Any Claude Code or CLI session using it will stop working."))
    return;
  errorMsg.value = null;
  revokeMutation.mutate(id);
}

const mcpSnippet = computed(() =>
  justCreated.value
    ? `claude mcp add --transport http treehouse ${mcpUrl} --header "x-api-key: ${justCreated.value.key}"`
    : "",
);
const cliSnippet = computed(() =>
  justCreated.value
    ? `export TREEHOUSE_API_BASE="${apiUrl}"\nexport TREEHOUSE_WORKSPACE_ID="<workspace-id>"  # the workspace to sync into\nexport TREEHOUSE_API_KEY="${justCreated.value.key}"\ntreehouse sync ./my-folder --watch`
    : "",
);
</script>

<template>
  <section class="space-y-4">
    <div>
      <p class="text-xs uppercase tracking-[0.2em] text-fg-subtle">Agents</p>
      <h3 class="text-lg font-semibold text-fg">Connect agents &amp; the CLI</h3>
    </div>

    <div class="space-y-2">
      <p class="text-sm text-fg-muted">
        Add Treehouse to your agent as a remote MCP server. It opens your browser so you can sign in
        and name the connection — there's no key to copy.
      </p>
      <pre class="overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">{{
        oauthSnippet
      }}</pre>
      <p class="text-xs text-fg-subtle">
        Other agents: add <code class="font-mono">{{ mcpUrl }}</code> as a remote (HTTP) MCP server.
      </p>
    </div>

    <McpConnections />

    <hr class="border-border" />

    <div>
      <p class="text-sm font-medium text-fg">API keys</p>
      <p class="text-sm text-fg-muted">
        For the sync CLI, and agents that can't sign in through a browser.
      </p>
    </div>

    <div
      v-if="error"
      class="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
    >
      {{ error }}
    </div>

    <!-- create -->
    <form class="space-y-3" @submit.prevent="create">
      <label class="block text-sm">
        <span class="mb-1 block text-fg-muted">Name</span>
        <input
          v-model="name"
          placeholder="my-laptop / claude-code"
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
      </label>
      <label class="block text-sm">
        <span class="mb-1 block text-fg-muted">Used by</span>
        <select
          v-model="actorType"
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        >
          <option value="agent">Agent (MCP)</option>
          <option value="human">Human (CLI)</option>
        </select>
      </label>
      <KeyScopeFields
        v-model:access="keyAccess"
        v-model:folder="keyReach"
        :folders="workspaceFolders"
        all-workspaces
      />
      <button
        type="submit"
        :disabled="creating"
        class="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-50"
      >
        {{ creating ? "Creating…" : "Create key" }}
      </button>
    </form>

    <!-- list -->
    <div v-if="loading" class="text-sm text-fg-subtle">Loading keys…</div>
    <ul v-else-if="keys.length" class="divide-y divide-border text-sm">
      <ApiKeyRow
        v-for="k in keys"
        :key="k.id"
        :api-key="k"
        :can-undo="canUndo(k)"
        @undo="undo(k)"
        @revoke="revoke(k.id)"
      />
    </ul>
    <p v-else class="text-sm text-fg-subtle">No keys yet.</p>

    <!-- display-once modal -->
    <div
      v-if="justCreated"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        class="w-full max-w-2xl space-y-4 rounded-xl border border-border bg-surface p-6 shadow-xl"
      >
        <h4 class="text-lg font-semibold text-fg">Key created — copy it now</h4>
        <p class="text-sm text-warning">
          This is the only time the full key is shown. Store it somewhere safe.
        </p>
        <code
          class="block overflow-auto rounded bg-neutral-900 p-3 font-mono text-sm text-emerald-300"
          >{{ justCreated.key }}</code
        >

        <div>
          <p class="mb-1 text-xs uppercase tracking-wider text-fg-subtle">Claude Code (MCP)</p>
          <pre class="overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">{{
            mcpSnippet
          }}</pre>
        </div>
        <div>
          <p class="mb-1 text-xs uppercase tracking-wider text-fg-subtle">Sync CLI</p>
          <pre class="overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">{{
            cliSnippet
          }}</pre>
        </div>

        <div class="flex justify-end">
          <button
            type="button"
            class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:bg-accent/90"
            @click="justCreated = null"
          >
            I've copied it
          </button>
        </div>
      </div>
    </div>
  </section>
</template>