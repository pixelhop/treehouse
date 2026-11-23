<script setup lang="ts">
import mascotOrganiseUrl from "design/assets/raster/mascot-organize.webp";
import type { WorkspaceInfo } from "~/composables/useTreehouseApi";
import {
  isAppMode,
  type LinkedWorkspace,
  normalizeWorkspaceName,
  parseLinkedFromHash,
  sentinelUrl,
} from "~/utils/connect";

// The desktop app's workspace step, rendered as a web page inside the shell's
// authed window. Picking or creating a workspace hands the id back to the shell by
// navigating to the sentinel path — see ~/utils/connect for why that has to be a
// full document navigation rather than a router push.
//
// Outside the shell this page has nothing useful to do: choosing a workspace here
// only matters because a folder gets created for it on the machine the shell is
// running on. So a plain browser gets a signpost instead of a picker.
definePageMeta({ middleware: "auth", layout: "onboarding" });

const route = useRoute();
const api = useTreehouseApi();

const appMode = isAppMode(route.query);

const workspaces = ref<WorkspaceInfo[]>([]);
const loading = ref(true);
const error = ref("");
const creating = ref(false);
// A plan refusal, kept as the error object so it can be explained rather than
// flattened into "We couldn't create that workspace." — which was the entire
// message a desktop user got for hitting the free-workspace cap, with no reason
// given and nothing to do next.
const planError = ref<unknown>(null);
const handingOff = ref("");
const newName = ref("");
const showCreate = ref(false);

// Workspaces that already have a folder on this Mac. The shell puts them in the
// URL fragment; a browser visit simply has none.
const linked = ref<LinkedWorkspace[]>([]);
const linkedFor = (id: string) => linked.value.find((l) => l.workspaceId === id);

onMounted(async () => {
  linked.value = parseLinkedFromHash(window.location.hash);
  try {
    const res = await api.listWorkspaces();
    workspaces.value = res.workspaces;
    // Nothing to choose between — go straight to naming one rather than showing
    // an empty list with a create link under it.
    if (res.workspaces.length === 0) showCreate.value = true;
  } catch {
    error.value = "We couldn't load your workspaces.";
  } finally {
    loading.value = false;
  }
});

/** Hand the chosen workspace back to the shell. */
function handOff(workspaceId: string) {
  handingOff.value = workspaceId;
  // Full navigation, NOT navigateTo: Electron's will-navigate doesn't fire for
  // client-side history changes, and the shell is listening on it.
  window.location.assign(sentinelUrl(window.location.origin, workspaceId));
}

const canCreate = computed(() => normalizeWorkspaceName(newName.value) !== null);

async function create() {
  const name = normalizeWorkspaceName(newName.value);
  if (!name || creating.value) return;
  creating.value = true;
  error.value = "";
  planError.value = null;
  try {
    const ws = await api.createWorkspace({ name });
    handOff(ws.id);
  } catch (e) {
    const status = (e as { statusCode?: number })?.statusCode ?? (e as { status?: number })?.status;
    if (status === 402) planError.value = e;
    else error.value = "We couldn't create that workspace.";
    creating.value = false;
  }
}

/** Back to the list of workspaces they already have. */
function chooseExisting() {
  planError.value = null;
  showCreate.value = false;
}
</script>

<template>
  <div class="flex-1 overflow-auto">
    <!-- Outside the desktop app this step is meaningless — it exists to tell the
         shell which workspace to make a folder for. -->
    <OnboardingStep
      v-if="!appMode"
      title="Open this in the Treehouse app"
      :illustration="mascotOrganiseUrl"
    >
      <template #body>
        This step sets up a folder on your computer, so it happens in the desktop app rather than
        the browser.
      </template>
      <NuxtLink
        to="/connect"
        class="inline-block rounded-full bg-accent px-7 py-3 text-sm font-semibold text-accent-fg no-underline transition hover:bg-accent/90"
      >
        Get the app
      </NuxtLink>
    </OnboardingStep>

    <OnboardingStep
      v-else
      eyebrow="Step one"
      :title="showCreate ? 'Name your workspace' : 'Which workspace comes home?'"
      :illustration="mascotOrganiseUrl"
    >
      <template #body>
        {{
          showCreate
            ? "You'll pick where it lives on this Mac next."
            : "Its files will live in a folder on this Mac — yours and your agents', kept in step."
        }}
      </template>

      <!-- loading -->
      <div v-if="loading" class="max-w-md space-y-2.5">
        <div v-for="i in 2" :key="i" class="h-[68px] animate-pulse rounded-2xl bg-surface-2" />
      </div>

      <!-- create -->
      <div v-else-if="showCreate" class="max-w-md">
        <!-- The headline above ("Name your workspace") is the visible label, but it
             is an <h1> rather than a <label>, so the field itself had no accessible
             name — and a placeholder is not one: it disappears the moment you type,
             leaving a screen reader with an unnamed text box mid-entry. -->
        <input
          v-model="newName"
          aria-label="Workspace name"
          placeholder="Acme"
          autocomplete="off"
          :disabled="creating"
          class="w-full rounded-2xl border border-border bg-surface px-5 py-4 text-[15px] text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
          @keyup.enter="create"
        />
        <p v-if="error" class="mt-3 text-sm text-danger">{{ error }}</p>

        <!-- The free-workspace cap, explained rather than swallowed. No buy
             button here on purpose: they came to set up a folder, not to shop,
             and the workspace they already own is one click away on this very
             screen. Upgrading stays available in the app itself. -->
        <PlanLimitNotice v-if="planError" class="mt-4 text-left" :error="planError">
          <template #action>
            <button
              type="button"
              class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90"
              @click="chooseExisting"
            >
              Use a workspace you already have
            </button>
          </template>
        </PlanLimitNotice>

        <button
          type="button"
          :disabled="!canCreate || creating"
          class="mt-5 rounded-full bg-accent px-7 py-3 text-sm font-semibold text-accent-fg transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          @click="create"
        >
          {{ creating ? "Planting…" : "Plant it" }}
        </button>
        <button
          v-if="workspaces.length"
          type="button"
          class="mt-4 block text-sm font-medium text-fg-muted transition hover:text-fg"
          @click="showCreate = false"
        >
          ← Choose an existing one
        </button>
      </div>

      <!-- choose -->
      <div v-else class="max-w-md space-y-2.5">
        <button
          v-for="w in workspaces"
          :key="w.id"
          type="button"
          :disabled="!!handingOff || !!linkedFor(w.id)"
          class="flex w-full items-center gap-4 rounded-2xl border px-5 py-4 text-left transition disabled:cursor-not-allowed"
          :class="
            linkedFor(w.id)
              ? 'border-border bg-surface-2 opacity-70'
              : handingOff === w.id
                ? 'border-accent bg-accent/5 ring-1 ring-accent'
                : 'border-border bg-surface hover:border-accent hover:bg-accent/5'
          "
          @click="handOff(w.id)"
        >
          <WorkspaceIcon :icon="w.icon" :color="w.color" :workspace-id="w.id" size="lg" />
          <span class="flex-1">
            <span class="block text-[15px] font-medium text-fg">{{ w.name }}</span>
            <!-- Shown rather than hidden: a workspace vanishing from the list
                 with no explanation is worse than one that says why. -->
            <span v-if="linkedFor(w.id)" class="block text-[13px] text-fg-subtle">
              Already growing in “{{ linkedFor(w.id)?.folderName }}”
            </span>
          </span>
          <span v-if="handingOff === w.id" class="text-sm text-accent">Opening…</span>
        </button>

        <p v-if="error" class="pt-2 text-sm text-danger">{{ error }}</p>

        <button
          type="button"
          class="pt-3 text-sm font-medium text-accent transition hover:opacity-80"
          @click="showCreate = true"
        >
          + New workspace
        </button>
      </div>
    </OnboardingStep>
  </div>
</template>