<script setup lang="ts">
import mascotFilesUrl from "design/assets/raster/mascot-files.webp";
import { hashParam, isAppMode } from "~/utils/connect";
import { requestedWorkspaceId } from "~/utils/desktopApp";

// What the desktop app's window shows while its native folder picker is open.
//
// The picker is a sheet on this window. Before this page existed the window kept
// whatever it was showing — after an "Open in Treehouse" link, a DIFFERENT
// workspace's page — so "choose a folder to sync" arrived under the wrong name,
// with nothing on screen saying which workspace the folder was for.
//
// Presentational only: the answer goes to the shell through the native dialog,
// never through this page. The suggested folder's name rides in the fragment
// (never sent to the server), the same way the other connect steps carry it.
definePageMeta({ middleware: "auth", layout: "onboarding" });

const route = useRoute();
const api = useTreehouseApi();

const appMode = isAppMode(route.query);
const workspaceId = requestedWorkspaceId(route.query);

const workspaceName = ref("");
const folderName = ref<string | null>(null);
const reclaim = ref(false);

onMounted(async () => {
  folderName.value = hashParam(window.location.hash, "folder");
  reclaim.value = hashParam(window.location.hash, "reclaim") === "1";
  if (!workspaceId) return;
  try {
    const res = await api.listWorkspaces();
    workspaceName.value = res.workspaces.find((w) => w.id === workspaceId)?.name ?? "";
  } catch {
    // The headline degrades to "this workspace" — the picker itself still names it.
  }
});

const title = computed(() =>
  workspaceName.value ? `Where should ${workspaceName.value} live?` : "Where should it live?",
);
</script>

<template>
  <div class="flex-1 overflow-auto">
    <OnboardingStep v-if="appMode" eyebrow="Step two" :title="title" :illustration="mascotFilesUrl">
      <template #body>
        <template v-if="reclaim && folderName">
          Your earlier <span class="font-mono text-[14px] text-fg">{{ folderName }}</span> folder is
          still on this Mac, so Treehouse will pick up where it left off — nothing is uploaded
          twice.
        </template>
        <template v-else-if="folderName">
          Choose a folder in the window that just opened. Treehouse suggests a new one called
          <span class="font-mono text-[14px] text-fg">{{ folderName }}</span> in your Treehouse
          folder.
        </template>
        <template v-else>Choose a folder in the window that just opened.</template>
      </template>
      <p class="max-w-md text-sm text-fg-subtle">
        Cancel if you'd rather not sync it now — the workspace stays usable here, and you can
        connect a folder any time.
      </p>
    </OnboardingStep>

    <OnboardingStep v-else title="Open this in the Treehouse app" :illustration="mascotFilesUrl">
      <template #body>
        This step chooses a folder on your computer, so it happens in the desktop app rather than
        the browser.
      </template>
      <NuxtLink
        :to="workspaceId ? `/connect?workspace=${encodeURIComponent(workspaceId)}` : '/connect'"
        class="inline-block rounded-full bg-accent px-7 py-3 text-sm font-semibold text-accent-fg no-underline transition hover:bg-accent/90"
      >
        Get the app
      </NuxtLink>
    </OnboardingStep>
  </div>
</template>