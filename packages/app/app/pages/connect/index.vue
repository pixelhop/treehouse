<script setup lang="ts">
import {
  buildOpenDeepLink,
  classifyArch,
  cliInstallOptions,
  connectOffer,
  DESKTOP_DOWNLOAD_URL,
  desktopAppSupport,
  detectOS,
  requestedWorkspaceId,
  type DetectedArch,
  type DetectedOS,
} from "~/utils/desktopApp";
import { sentinelUrl } from "~/utils/connect";

// The web → folder hand-off (U7 / R6).
//
// Arriving by invite link, you're told about the app. Creating a workspace here
// you were told nothing — the half of Treehouse that syncs a folder on your own
// machine was invisible unless someone else set it up for you. This page is where
// workspace creation now lands, and it makes exactly one decision: which way to
// send this visitor (see `connectOffer`). Every branch goes somewhere.
//
// The workspace id comes off the query so the deep link can name it. It's
// optional: without one the download and the CLI are still worth offering, we
// just can't ask an installed app to open a specific workspace.
definePageMeta({ middleware: "auth", layout: "onboarding" });

const route = useRoute();

const workspaceId = requestedWorkspaceId(route.query);

// Inside the desktop app the whole premise of this page is already satisfied.
// Client-only: SSR has no navigator, so it resolves after mount.
const inShell = ref(false);
const api = useTreehouseApi();
const workspaceName = ref("");
onMounted(async () => {
  inShell.value = isDesktopShell();
  // Just created in the app (see WorkspaceSwitcher): skip the offer and go straight
  // to the folder. The shell takes over the window, so this page is only a frame.
  if (inShell.value && workspaceId && route.query.created === "1") connectFolder();
  if (!workspaceId) return;
  try {
    workspaceName.value =
      (await api.listWorkspaces()).workspaces.find((w) => w.id === workspaceId)?.name ?? "";
  } catch {
    // The copy falls back to "this workspace".
  }
});

/** Ask the shell to connect a folder for this workspace.
 *
 * A FULL document navigation, not navigateTo: the shell recognises this by
 * watching `will-navigate`, which client-side history changes do not fire. The
 * shell cancels the navigation and takes over, so this page stays put. */
function connectFolder() {
  if (!workspaceId) return;
  window.location.assign(sentinelUrl(window.location.origin, workspaceId));
}

const detectedOS: DetectedOS =
  typeof navigator === "undefined"
    ? "unknown"
    : detectOS({
        platform: userAgentData()?.platform ?? navigator.platform,
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        uaMobile: userAgentData()?.mobile,
      });

// Arch is Chromium-only and async; until it resolves we treat it as unknown,
// which desktopAppSupport already handles (offer the Mac build, with a caveat).
const osArch = ref<DetectedArch>("unknown");

const support = computed(() => desktopAppSupport(detectedOS, osArch.value));
const offer = computed(() => connectOffer(detectedOS, osArch.value));

const installOptions = computed(() => cliInstallOptions(detectedOS));
const loginCommand = "treehouse login ~/my-folder";

// Deep-linking into an installed app needs a workspace to open. `window` is
// unavailable during SSR-less hydration on the very first tick, hence the guard.
const openLink = computed(() =>
  workspaceId
    ? buildOpenDeepLink({
        workspaceId,
        appOrigin: typeof window === "undefined" ? undefined : window.location.origin,
      })
    : "",
);

const workspaceHref = computed(() => (workspaceId ? `/w/${workspaceId}` : "/workspace"));

// Set once the download has started. The page used to stay exactly as it was, so
// the freshly installed app opened with no idea which workspace the user had been
// looking at, and asked them to choose it again. After a download the page says
// what to do next and makes "open THIS workspace in the app" the main button —
// the link names the workspace, so the app's first launch goes straight to its
// folder.
const downloaded = ref(false);

const copied = ref("");

async function copy(text: string, which: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = which;
    setTimeout(() => {
      if (copied.value === which) copied.value = "";
    }, 1600);
  } catch {
    // clipboard blocked — the user can select the text manually
  }
}

onMounted(async () => {
  const uaData = userAgentData();
  if (uaData?.getHighEntropyValues) {
    try {
      const hv = await uaData.getHighEntropyValues(["architecture", "bitness"]);
      const arch = classifyArch(hv.architecture, hv.bitness);
      if (arch !== "unknown") osArch.value = arch;
    } catch {
      // best-effort — leave as "unknown"
    }
  }
});
</script>

<template>
  <!-- No AppTopBar: this page uses the chromeless `onboarding` layout precisely
       so a half-finished flow has nowhere else to go. The bar brought a sidebar
       toggle with it — a control for a sidebar this layout doesn't render,
       which silently flipped the workspace's own panel state for later. -->

  <div class="flex-1 overflow-auto">
    <div class="mx-auto w-full max-w-xl px-6 py-12 sm:py-20">
      <!-- Already inside the desktop app: there is nothing to download, and the
           folder is connected from the menubar rather than from a web page. -->
      <div v-if="inShell" class="reveal">
        <p class="text-sm font-medium tracking-wide text-accent uppercase">
          Your workspace is live
        </p>
        <h1 class="mt-2 font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          {{ workspaceName ? `Sync ${workspaceName} to this Mac` : "Sync a folder" }}
        </h1>
        <p class="mt-3 max-w-prose text-[15px] leading-relaxed text-fg-muted">
          Treehouse can keep a folder on this Mac in sync with
          {{ workspaceName ? workspaceName : "this workspace" }}&nbsp;— the same files you and your
          agents both work on.
        </p>

        <!-- An offer, not a redirect: it hands off to the shell, which asks where
             the folder should live. Declining leaves the workspace perfectly
             usable, and the menubar can connect it later. -->
        <button
          v-if="workspaceId"
          type="button"
          class="mt-8 w-full max-w-sm rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-accent-fg transition hover:bg-accent/90"
          @click="connectFolder"
        >
          Choose a folder…
        </button>

        <div class="mt-6 flex items-center gap-4 text-sm">
          <NuxtLink
            :to="workspaceId ? `/w/${workspaceId}` : '/workspace'"
            class="font-medium text-fg-muted no-underline transition hover:text-fg"
          >
            Not now
          </NuxtLink>
          <span class="text-fg-subtle">·</span>
          <span class="text-fg-subtle"
            >You can connect one any time from the Treehouse menu bar icon.</span
          >
        </div>
      </div>

      <div v-else class="reveal">
        <p class="text-sm font-medium tracking-wide text-accent uppercase">
          Your workspace is live
        </p>
        <h1 class="mt-2 font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          Sync a folder
        </h1>
        <p class="mt-3 max-w-prose text-[15px] leading-relaxed text-fg-muted">
          Treehouse can keep a folder on your computer in sync with
          {{ workspaceName || "this workspace" }}&nbsp;— the same files you and your agents both
          work on. Drop a file in, it shows up here; change it here, it lands on your machine.
        </p>

        <!-- detected platform -->
        <div class="mt-9 mb-3 flex items-center gap-2 text-sm text-fg-subtle">
          <svg
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
          <span
            >Detected <span class="font-medium text-fg">{{ support.label }}</span></span
          >
        </div>

        <!-- ── the desktop app runs here ── -->
        <template v-if="offer === 'download'">
          <!-- after the download: the next step, and this workspace's hand-off -->
          <div
            v-if="downloaded && openLink"
            class="mb-5 rounded-xl border border-border bg-surface-2 px-5 py-4 text-[14px] leading-relaxed text-fg-muted"
          >
            <p class="font-medium text-fg">Downloading…</p>
            <p class="mt-1">
              Open <span class="font-mono text-[13px] text-fg">Treehouse-arm64.dmg</span>, drag
              Treehouse into Applications, then come back here.
            </p>
            <a
              :href="openLink"
              class="mt-4 flex w-full items-center justify-center rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-fg no-underline transition hover:bg-accent/90"
            >
              {{
                workspaceName
                  ? `Open ${workspaceName} in Treehouse`
                  : "Open this workspace in Treehouse"
              }}
            </a>
          </div>
          <a
            v-if="!downloaded || !openLink"
            :href="DESKTOP_DOWNLOAD_URL"
            class="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-fg no-underline transition hover:bg-accent/90"
            @click="downloaded = true"
          >
            <svg
              class="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
              />
            </svg>
            Download the Mac app
          </a>
          <p
            v-if="!downloaded || !openLink"
            class="mt-3 text-[13px] leading-relaxed text-fg-subtle"
          >
            Sign in, pick a folder, and it starts syncing. No terminal needed.
          </p>
          <p v-if="support.note" class="mt-2 text-[13px] leading-relaxed text-fg-subtle">
            {{ support.note }}
          </p>

          <!-- already installed: hand this workspace straight to the app -->
          <a
            v-if="openLink && !downloaded"
            :href="openLink"
            class="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent no-underline transition hover:opacity-80"
          >
            Already have the app? Open {{ workspaceName || "this workspace" }} in it →
          </a>

          <!-- The app is the way in; the terminal is for people who'd rather.
               Small, below, and last — but present, because leaving it out sent
               anyone who prefers the CLI back to guess at a URL. -->
          <p class="mt-4 text-[13px] text-fg-subtle">
            Rather use the terminal?
            <NuxtLink
              to="/link"
              class="font-medium text-fg-muted underline underline-offset-2 transition hover:text-fg"
            >
              Sync with the CLI instead
            </NuxtLink>
          </p>
        </template>

        <!-- ── no Mac app yet, but the CLI syncs a folder anywhere ── -->
        <template v-else-if="offer === 'cli'">
          <p class="rounded-xl border border-border bg-surface-2 px-4 py-3.5 text-sm text-fg-muted">
            {{ support.note }}
          </p>

          <div class="mt-6 space-y-3">
            <div class="flex items-center gap-2 text-sm font-medium text-fg-subtle">
              <span
                class="grid h-5 w-5 place-items-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent"
                >1</span
              >
              Install the Treehouse command line tool
            </div>
            <div v-for="opt in installOptions" :key="opt.command" class="space-y-1.5">
              <p v-if="detectedOS === 'unknown'" class="text-xs font-medium text-fg-subtle">
                {{ opt.label }}
              </p>
              <div
                class="flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3.5 font-mono text-sm"
              >
                <span aria-hidden="true" class="select-none text-fg-subtle">$</span>
                <code class="flex-1 truncate text-fg">{{ opt.command }}</code>
                <button
                  type="button"
                  class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-app hover:text-fg"
                  :aria-label="copied === opt.command ? 'Copied' : 'Copy command'"
                  @click="copy(opt.command, opt.command)"
                >
                  {{ copied === opt.command ? "Copied" : "Copy" }}
                </button>
              </div>
            </div>

            <div class="flex items-center gap-2 text-sm font-medium text-fg-subtle">
              <span
                class="grid h-5 w-5 place-items-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent"
                >2</span
              >
              Point it at the folder you want synced
            </div>
            <div
              class="flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3.5 font-mono text-sm"
            >
              <span aria-hidden="true" class="select-none text-fg-subtle">$</span>
              <code class="flex-1 truncate text-fg">{{ loginCommand }}</code>
              <button
                type="button"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-app hover:text-fg"
                :aria-label="copied === 'login' ? 'Copied' : 'Copy command'"
                @click="copy(loginCommand, 'login')"
              >
                {{ copied === "login" ? "Copied" : "Copy" }}
              </button>
            </div>
          </div>

          <NuxtLink
            to="/link"
            class="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent no-underline transition hover:opacity-80"
          >
            Walk me through it →
          </NuxtLink>
        </template>

        <!-- ── a phone or tablet (no folder to sync), or Windows/Linux (coming soon) ── -->
        <template v-else>
          <p class="rounded-xl border border-border bg-surface-2 px-4 py-3.5 text-sm text-fg-muted">
            {{ support.note }}
          </p>
        </template>

        <!-- always a way onward -->
        <div class="mt-10 flex items-center justify-between border-t border-border pt-6">
          <p class="text-sm text-fg-muted">Not now?</p>
          <NuxtLink
            :to="workspaceHref"
            class="rounded-lg px-4 py-2 text-sm font-medium text-accent no-underline transition hover:bg-accent/10"
          >
            Open the workspace →
          </NuxtLink>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped></style>