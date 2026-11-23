<script setup lang="ts">
import leafSprigUrl from "design/assets/motif/leaf-sprig.svg";
import IconCheck from "~icons/solar/check-circle-bold";
import IconFolder from "~icons/solar/folder-with-files-linear";
import { needsSetup } from "~/utils/setupPrompt";

// The post-login home screen. It answers one question — "what do I do next?" —
// and it answers it in order:
//
//   1. Your workspace. The destination, the hero: named, iconed, one filled
//      button. Everything else on this page is smaller than it.
//   2. Set it up (only while it needs setting up). The same WorkspaceSetupCard
//      the workspace view shows, so there is one agent hand-off in the product,
//      not two — and it retires itself here exactly as it does there.
//   3. Sync a folder, then invite someone. Real next steps, in the order they
//      make sense, visibly subordinate to the hero.
//
// Everything it knows, it knows from state already in the shared cache
// (workspace meta + file list + the desktop shell's folder list). No new
// endpoints, no stat tiles.
definePageMeta({ middleware: "auth", layout: "app" });

const authClient = useAuthClient();
const session = authClient.useSession();
const ws = useWorkspaceData();

const firstName = computed(() => {
  const name = (session.value.data?.user?.name ?? "").trim();
  return name ? (name.split(/\s+/)[0] ?? "") : "";
});

const workspaceHref = computed(() =>
  ws.workspaceId.value ? `/w/${ws.workspaceId.value}` : "/workspace",
);

// Un-set-up workspace → the agent hand-off belongs on this page. Gated on
// !loading so it never flashes in after the file list resolves, which would
// read as a glitch on the first screen a new user sees.
const setupPending = computed(
  () => !ws.loading.value && !!ws.workspace.value && needsSetup(ws.tree.value),
);

// Only the desktop shell knows a local folder exists; in a browser this stays
// null (and the folder card keeps offering the hand-off).
const desktopFolders = useDesktopFolders();
onMounted(() => {
  void desktopFolders.refresh();
});
const syncedFolderName = computed(() => {
  const id = ws.workspaceId.value;
  return id ? (desktopFolders.folderFor(id)?.folderName ?? null) : null;
});

// Counts come off the file list the sidebar already loaded — numbers beat
// adjectives, and these cost nothing. `.keep` placeholders are folder scaffolding,
// not files (the tree drops them too).
const fileCount = computed(
  () => ws.entries.value.filter((e) => e.path.split("/").pop() !== ".keep").length,
);
const folderCount = computed(() => {
  const dirs = new Set<string>();
  for (const entry of ws.entries.value) {
    const parts = entry.path.split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      dirs.add(acc);
    }
  }
  return dirs.size;
});
const summary = computed(() => {
  if (ws.loading.value || !ws.workspace.value) return "";
  if (setupPending.value) return "Nothing planted here yet.";
  const files = `${fileCount.value} ${fileCount.value === 1 ? "file" : "files"}`;
  if (!folderCount.value) return `${files}.`;
  return `${files} in ${folderCount.value} ${folderCount.value === 1 ? "folder" : "folders"}.`;
});

// Syncing a folder: /connect is the desktop-app-first hand-off — it leads with
// the app, keeps the CLI as the smaller alternative, and adapts to where it is
// opened (inside the shell it just picks a folder). It needs the workspace to
// name; without one, the CLI device flow is still worth offering. The dashboard
// card deliberately shows no terminal command of its own: the app is the way in.
const connectHref = computed(() =>
  ws.workspaceId.value ? `/connect?workspace=${encodeURIComponent(ws.workspaceId.value)}` : "/link",
);
</script>

<template>
  <AppTopBar title="Dashboard" />

  <div class="flex-1 overflow-auto">
    <div class="mx-auto max-w-3xl px-6 py-10 sm:px-8 sm:py-12">
      <!-- ── The hero: the workspace you're about to walk into ── -->
      <section
        class="relative overflow-hidden rounded-2xl border border-border bg-surface p-6 sm:p-8"
      >
        <img
          :src="leafSprigUrl"
          alt=""
          aria-hidden="true"
          class="pointer-events-none absolute -top-3 -right-3 hidden h-24 w-24 opacity-25 sm:block"
        />

        <p class="text-xs font-semibold tracking-[0.14em] text-fg-subtle uppercase">
          {{ setupPending ? "Welcome" : "Welcome back" }}{{ firstName ? `, ${firstName}` : "" }}
        </p>

        <div v-if="ws.workspace.value" class="relative mt-4 flex items-start gap-4">
          <WorkspaceIcon
            :icon="ws.workspace.value.icon"
            :color="ws.workspace.value.color"
            :workspace-id="ws.workspaceId.value"
            size="lg"
          />
          <div class="min-w-0 flex-1">
            <h1 class="font-display text-3xl leading-tight font-semibold tracking-tight text-fg">
              {{ ws.workspace.value.name }}
            </h1>
            <p v-if="summary" class="mt-2 text-[15px] leading-relaxed text-fg-muted">
              {{ summary }}
              <span v-if="syncedFolderName">
                Synced with
                <span class="font-mono text-[13px] text-fg">{{ syncedFolderName }}</span
                >.
              </span>
            </p>
          </div>
        </div>

        <!-- No workspace at all: rare (signing up mints one), but the page must
             still say something true rather than render an empty hero. -->
        <div v-else-if="!ws.loading.value" class="mt-4">
          <h1 class="font-display text-3xl leading-tight font-semibold tracking-tight text-fg">
            No workspace yet
          </h1>
          <p class="mt-2 text-[15px] leading-relaxed text-fg-muted">
            Create one from the workspace switcher at the top of the sidebar, and this page will
            show you around it.
          </p>
        </div>

        <div v-if="ws.workspace.value" class="mt-7 flex flex-wrap items-center gap-4">
          <NuxtLink
            :to="workspaceHref"
            class="rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-fg no-underline transition hover:bg-accent/90"
          >
            Open {{ ws.workspace.value.name }}
          </NuxtLink>
          <span v-if="ws.workspaces.value.length > 1" class="text-sm text-fg-subtle">
            {{ ws.workspaces.value.length - 1 }} other
            {{ ws.workspaces.value.length === 2 ? "workspace" : "workspaces" }}
            — switch in the sidebar.
          </span>
        </div>
      </section>

      <!-- ── Set it up, while it still needs setting up ──
           The workspace view's card, unchanged: one hand-off, one prompt, and it
           leaves of its own accord the moment folders exist. -->
      <WorkspaceSetupCard
        v-if="setupPending && ws.workspace.value"
        class="mt-6"
        :workspace-name="ws.workspace.value.name"
        :workspace-id="ws.workspace.value.id"
        :folder-name="syncedFolderName"
      />

      <!-- ── Then the two things worth doing next, in that order ── -->
      <h2 class="mt-10 text-xs font-semibold tracking-[0.14em] text-fg-subtle uppercase">
        Next steps
      </h2>
      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <!-- 1. Get the files onto your own machine. -->
        <div class="rounded-2xl border border-border bg-surface p-5">
          <span
            class="grid h-9 w-9 place-items-center rounded-lg bg-accent/10 text-accent"
            aria-hidden="true"
          >
            <IconFolder class="h-4 w-4" />
          </span>
          <h3 class="mt-3.5 text-[15px] font-semibold text-fg">Sync a folder</h3>
          <p class="mt-1.5 text-sm leading-relaxed text-fg-muted">
            Keep a folder on your computer in step with this workspace — the same files you and your
            agents both work on.
          </p>
          <span
            v-if="syncedFolderName"
            class="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-success"
          >
            <IconCheck class="h-4 w-4" aria-hidden="true" />
            <span class="font-mono text-[13px]">{{ syncedFolderName }}</span>
          </span>
          <NuxtLink
            v-else
            :to="connectHref"
            class="mt-3 inline-block text-sm font-medium text-accent no-underline transition hover:opacity-80"
          >
            Sync a folder →
          </NuxtLink>
        </div>

        <!-- 2. Bring someone else in. Viewers can't, so it isn't offered. -->
        <DashboardInviteCard v-if="!ws.viewOnly.value" />
      </div>
    </div>
  </div>
</template>