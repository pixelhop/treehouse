<script setup lang="ts">
// The people who can see the current workspace, and (for owners/admins) a way
// to remove one. Membership is per-workspace: removing someone here takes away
// this workspace only, and revokes the sync keys they hold for it — their other
// workspaces are untouched.
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";

const api = useTreehouseApi();
const qc = useQueryClient();
const ws = useWorkspaceData();
const session = useAuthClient().useSession();

const workspaceId = computed(() => ws.workspaceId.value);
const workspaceName = computed(() => ws.workspace.value?.name ?? "this workspace");
const meId = computed(() => session.value.data?.user?.id ?? null);

const errorMsg = ref<string | null>(null);

const membersQuery = useQuery({
  queryKey: computed(() => ["members", workspaceId.value]),
  queryFn: () => api.getMembers(workspaceId.value as string).then((r) => r.members),
  enabled: computed(() => !!workspaceId.value),
});
const members = computed(() => membersQuery.data.value ?? []);
const loading = computed(() => membersQuery.isPending.value);
const error = computed(
  () => errorMsg.value ?? (membersQuery.error.value as Error | null)?.message ?? null,
);

/** better-auth stores roles as a comma-separated list ("owner", "admin,member"). */
const hasRole = (role: string, wanted: string) =>
  role
    .split(",")
    .map((r) => r.trim())
    .includes(wanted);

const myRole = computed(() => members.value.find((m) => m.id === meId.value)?.role ?? "");
const canManage = computed(() => hasRole(myRole.value, "owner") || hasRole(myRole.value, "admin"));
const ownerCount = computed(() => members.value.filter((m) => hasRole(m.role, "owner")).length);

/** Mirrors the server's rules, so the UI never offers an action that would 4xx. */
function canRemove(member: { id: string; role: string }): boolean {
  if (!canManage.value) return false;
  if (hasRole(member.role, "owner")) {
    // Only an owner can remove an owner, and never the last one.
    return hasRole(myRole.value, "owner") && ownerCount.value > 1;
  }
  return true;
}

const removeMutation = useMutation({
  mutationFn: (userId: string) => api.removeMember(workspaceId.value as string, userId),
  onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ["members", workspaceId.value] });
    // Removing yourself costs you the workspace, so the switcher must reload.
    void qc.invalidateQueries({ queryKey: ["workspaces"] });
  },
  onError: (e) => {
    errorMsg.value = (e as Error).message;
  },
});
const removingId = ref<string | null>(null);

function remove(member: { id: string; name: string }) {
  const self = member.id === meId.value;
  const question = self
    ? `Leave ${workspaceName.value}? You'll lose access to its files, and any folder you sync from it will stop syncing.`
    : `Remove ${member.name} from ${workspaceName.value}? They'll lose access to its files, and any folder they sync from it will stop syncing.`;
  if (!confirm(question)) return;
  errorMsg.value = null;
  removingId.value = member.id;
  removeMutation.mutate(member.id, {
    onSettled: () => {
      removingId.value = null;
    },
  });
}

const ROLE_LABELS = ["Owner", "Admin", "Member", "Viewer"];
/** Highest first, as the server reads a comma-separated role list. */
const roleLabel = (role: string) =>
  ROLE_LABELS.find((label) => hasRole(role, label.toLowerCase())) ?? "Viewer";

/** Someone I can't change: an owner, or an admin unless I'm an owner myself. */
const outranksMe = (role: string) =>
  hasRole(role, "owner") || (hasRole(role, "admin") && !hasRole(myRole.value, "owner"));

/** Mirrors the server's rules, so the UI never offers an action that would 4xx. */
function canChangeRole(member: { id: string; role: string }): boolean {
  return canManage.value && member.id !== meId.value && !outranksMe(member.role);
}

const roleMutation = useMutation({
  mutationFn: (vars: { userId: string; role: "member" | "viewer" }) =>
    api.setMemberRole(workspaceId.value as string, vars.userId, vars.role),
  onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ["members", workspaceId.value] });
  },
  onError: (e) => {
    errorMsg.value = (e as Error).message;
    // The select already moved; put it back by reloading what the server holds.
    void qc.invalidateQueries({ queryKey: ["members", workspaceId.value] });
  },
});

function changeRole(userId: string, role: string) {
  if (role !== "member" && role !== "viewer") return;
  errorMsg.value = null;
  roleMutation.mutate({ userId, role });
}
</script>

<template>
  <section class="space-y-4">
    <div>
      <p class="text-xs tracking-[0.2em] text-fg-subtle uppercase">Members</p>
      <h3 class="text-lg font-semibold text-fg">Who can see {{ workspaceName }}</h3>
      <p class="mt-1 text-sm text-fg-muted">
        Each workspace has its own members. Removing someone here takes away this workspace only —
        your other workspaces stay private.
      </p>
      <!-- The plans are per member and the Stripe quantity follows this list, so
           this panel is exactly where the cost of a seat belongs. -->
      <SeatCostNote class="mt-2" :billing="ws.usage.value?.billing" />
    </div>

    <div
      v-if="error"
      class="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
    >
      {{ error }}
    </div>

    <p v-if="loading" class="text-sm text-fg-subtle">Loading members…</p>
    <ul v-else-if="members.length" class="divide-y divide-border text-sm">
      <li v-for="m in members" :key="m.id" class="flex items-center gap-3 py-2.5">
        <img
          v-if="m.image"
          :src="m.image"
          alt=""
          aria-hidden="true"
          class="h-8 w-8 shrink-0 rounded-full object-cover"
        />
        <span
          v-else
          aria-hidden="true"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-medium text-fg-muted"
        >
          {{ (m.name || "?").slice(0, 1).toUpperCase() }}
        </span>
        <span class="min-w-0 flex-1 truncate text-fg">
          {{ m.name }}
          <span v-if="m.id === meId" class="text-fg-subtle">(you)</span>
        </span>
        <select
          v-if="canChangeRole(m)"
          :value="roleLabel(m.role).toLowerCase()"
          :aria-label="`Role for ${m.name}`"
          class="shrink-0 rounded border border-border bg-surface px-1.5 py-1 text-xs text-fg outline-none"
          @change="changeRole(m.id, ($event.target as HTMLSelectElement).value)"
        >
          <option v-if="roleLabel(m.role) === 'Admin'" value="admin" disabled>Admin</option>
          <option value="member">Member</option>
          <option value="viewer">Viewer</option>
        </select>
        <span v-else class="shrink-0 text-xs text-fg-subtle">{{ roleLabel(m.role) }}</span>
        <button
          v-if="canRemove(m)"
          type="button"
          :disabled="removingId === m.id"
          class="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted transition hover:border-danger/40 hover:text-danger disabled:opacity-50"
          @click="remove(m)"
        >
          {{ removingId === m.id ? "Removing…" : m.id === meId ? "Leave" : "Remove" }}
        </button>
      </li>
    </ul>
    <p v-else class="text-sm text-fg-subtle">No members yet.</p>

    <OrphanedItems v-if="hasRole(myRole, 'owner')" @error="errorMsg = $event" />

    <p v-if="!loading" class="text-[13px] text-fg-subtle">
      Members can change files. Viewers can read and comment, but change nothing.
      <template v-if="!canManage">Only an owner or admin can change this.</template>
    </p>
  </section>
</template>