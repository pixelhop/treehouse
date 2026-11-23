<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import {
  buildInviteDeepLink,
  classifyArch,
  desktopAppSupport,
  detectOS,
  DESKTOP_DOWNLOAD_URL,
  inviteView,
  type DetectedArch,
  type DetectedOS,
} from "~/utils/desktopApp";

// Accept a shareable workspace invite. Logged-out users sign in first (auth
// middleware), then land back here to join. Accepting adds them to the
// workspace — and to that workspace only; every other workspace the inviter
// owns stays private.
//
// After accepting, the page does NOT auto-redirect (U5): it offers the desktop
// app — "Open in Treehouse" (user-initiated treehouse:// deep link) and a Mac
// download — while keeping the web workspace one click away. The page stays live
// so the user can return and click again once the app is installed.
definePageMeta({ middleware: "auth", layout: "app" });

const route = useRoute();
const api = useTreehouseApi();
const qc = useQueryClient();

const token = computed(() => String(route.params.token ?? ""));

type Preview = Awaited<ReturnType<ReturnType<typeof useTreehouseApi>["getInvite"]>>;
const preview = ref<Preview | null>(null);
const loading = ref(true);
const accepting = ref(false);
const accepted = ref(false);
const acceptedWorkspaceId = ref("");
const error = ref("");

// ── Desktop-app platform detection (shared with link.vue) ──
const osArch = ref<DetectedArch>("unknown");
const detectedOS: DetectedOS =
  typeof navigator === "undefined"
    ? "unknown"
    : detectOS({
        platform:
          (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
            ?.platform ?? navigator.platform,
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        uaMobile: (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
          ?.mobile,
      });
// Inside the desktop app there is nothing to download and no deep link to fire —
// the shell is already here. Client-only, so it settles after mount.
const inShell = ref(false);
onMounted(() => {
  inShell.value = isDesktopShell();
});

const support = computed(() => desktopAppSupport(detectedOS, osArch.value));

// The deep link carries the app origin (for API-origin discovery, U4) + workspace.
const appOrigin = computed(() => (typeof window === "undefined" ? "" : window.location.origin));
const deepLink = computed(() =>
  buildInviteDeepLink({
    token: token.value,
    workspaceId: acceptedWorkspaceId.value,
    appOrigin: appOrigin.value,
  }),
);

const view = computed(() =>
  inviteView({
    loading: loading.value,
    accepted: accepted.value,
    error: !!error.value,
    previewValid: !!preview.value?.valid,
  }),
);

function statusOf(e: unknown): number | undefined {
  return (e as { statusCode?: number }).statusCode ?? (e as { status?: number }).status;
}

function markAccepted(res: { workspaceId: string }) {
  acceptedWorkspaceId.value = res.workspaceId;
  accepted.value = true;
}

/**
 * Open the workspace in the browser. The workspace list is the union of the
 * user's memberships, so there is nothing to "activate" — the new workspace is
 * already theirs. It just has to be re-fetched: the cached list predates the
 * join and would otherwise leave the switcher a workspace short.
 */
async function openWorkspaceInBrowser() {
  await qc.invalidateQueries({ queryKey: ["workspaces"] });
  await navigateTo(`/w/${acceptedWorkspaceId.value}`);
}

onMounted(async () => {
  // Refine arch where the browser exposes it (Chromium only) — needed to spot
  // Intel Macs, which the Apple-Silicon-only desktop app doesn't support.
  const uaData = (
    navigator as Navigator & {
      userAgentData?: {
        getHighEntropyValues?: (
          h: string[],
        ) => Promise<{ architecture?: string; bitness?: string }>;
      };
    }
  ).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const hv = await uaData.getHighEntropyValues(["architecture", "bitness"]);
      const arch = classifyArch(hv.architecture, hv.bitness);
      if (arch !== "unknown") osArch.value = arch;
    } catch {
      // best-effort — leave as "unknown"
    }
  }

  try {
    preview.value = await api.getInvite(token.value);
    if (!preview.value.valid) {
      // A returning member of a spent single-use invite still deserves the app
      // offer, not the "unavailable" dead end. accept is idempotent and only
      // consumes a use when a NEW membership is created, so this probe never
      // silently joins a non-member — they get a 4xx and fall through to invalid.
      try {
        const res = await api.acceptInvite(token.value);
        if (res.ok) markAccepted(res);
      } catch {
        // Not a member / genuinely unavailable — leave as the invalid branch.
      }
    }
  } catch (e) {
    error.value =
      statusOf(e) === 404 ? "This invite link isn't valid." : "We couldn't load this invite.";
  } finally {
    loading.value = false;
  }
});

async function accept() {
  error.value = "";
  accepting.value = true;
  try {
    const res = await api.acceptInvite(token.value);
    markAccepted(res);
  } catch (e) {
    const s = statusOf(e);
    error.value =
      s === 410
        ? "This invite has expired."
        : s === 409
          ? "This invite is no longer usable."
          : "That didn't work — the invite may have expired.";
  } finally {
    accepting.value = false;
  }
}

function openApp() {
  // User-initiated custom-scheme navigation — browsers block automatic
  // treehouse:// redirects, so this only fires on click and stays re-triggerable.
  window.location.href = deepLink.value;
}
</script>

<template>
  <AppTopBar title="Join workspace" />

  <div class="flex-1 overflow-auto">
    <div class="mx-auto w-full max-w-md px-6 py-12 sm:py-20">
      <Transition name="step" mode="out-in">
        <!-- loading -->
        <div v-if="view === 'loading'" key="loading" class="space-y-4">
          <div class="h-16 animate-pulse rounded-xl bg-surface-2" />
          <div class="h-10 w-2/3 animate-pulse rounded-lg bg-surface-2" />
        </div>

        <!-- accepted → offer the desktop app (no auto-redirect) -->
        <div
          v-else-if="view === 'offer'"
          key="offer"
          class="flex flex-col items-center pt-6 text-center"
        >
          <span class="success-badge grid h-20 w-20 place-items-center rounded-full bg-success/10">
            <svg class="h-10 w-10 text-success" viewBox="0 0 52 52" fill="none">
              <circle
                class="success-ring"
                cx="26"
                cy="26"
                r="23"
                stroke="currentColor"
                stroke-width="3"
              />
              <path
                class="success-check"
                d="M15 27.5 22.5 35 38 18"
                stroke="currentColor"
                stroke-width="4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <h1 class="success-text mt-7 font-display text-2xl font-semibold tracking-tight text-fg">
            You're in 🌳
          </h1>
          <p
            class="success-text mt-2 max-w-sm text-[15px] leading-relaxed text-fg-muted"
            style="--d: 90ms"
          >
            <template v-if="inShell">
              Choose <span class="font-medium text-fg">Add a Folder…</span> from the Treehouse icon
              in your menu bar to sync this workspace to a folder on this Mac.
            </template>
            <template v-else-if="support.supported">
              Get the Treehouse app to sync this workspace to a folder on your Mac — the same files
              you and your agents both work on.
            </template>
            <template v-else> Your workspace is ready. </template>
          </p>

          <!-- Already in the app: no download, no deep link — just go to the files. -->
          <template v-if="inShell">
            <button
              type="button"
              class="success-text mt-8 w-full max-w-xs rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-fg transition hover:bg-accent/90"
              style="--d: 150ms"
              @click="openWorkspaceInBrowser"
            >
              Open the workspace →
            </button>
          </template>

          <!-- Apple-Silicon Mac: app offer is primary, browser is the escape hatch -->
          <template v-else-if="support.supported">
            <div class="success-text mt-8 flex w-full max-w-xs flex-col gap-2.5" style="--d: 150ms">
              <button
                type="button"
                class="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-fg transition hover:bg-accent/90"
                @click="openApp"
              >
                Open in Treehouse
              </button>
              <a
                :href="DESKTOP_DOWNLOAD_URL"
                class="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium text-fg no-underline transition hover:bg-surface-2"
              >
                Download for Mac (Apple Silicon)
              </a>
            </div>
            <button
              type="button"
              class="success-text mt-4 text-sm font-medium text-fg-muted transition hover:text-fg"
              style="--d: 210ms"
              @click="openWorkspaceInBrowser"
            >
              or open in your browser →
            </button>
          </template>

          <!-- Everyone else (Windows/Linux/mobile/Intel Mac): web path is first-class -->
          <template v-else>
            <button
              type="button"
              class="success-text mt-8 flex w-full max-w-xs items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-fg transition hover:bg-accent/90"
              style="--d: 150ms"
              @click="openWorkspaceInBrowser"
            >
              Open workspace →
            </button>
            <p
              class="success-text mt-4 max-w-xs text-[13px] leading-relaxed text-fg-subtle"
              style="--d: 210ms"
            >
              {{ support.note }}
            </p>
          </template>
        </div>

        <!-- invalid / expired -->
        <div
          v-else-if="view === 'invalid'"
          key="invalid"
          class="reveal rounded-2xl border border-border bg-surface p-7 text-center"
        >
          <h1 class="text-xl font-semibold text-fg">Invite unavailable</h1>
          <p class="mt-2 text-[15px] text-fg-muted">
            {{
              error ||
              (preview?.expired
                ? "This invite link has expired."
                : preview?.exhausted
                  ? "This invite link has been used up."
                  : "This invite link isn't valid.")
            }}
          </p>
          <NuxtLink
            to="/dashboard"
            class="mt-6 inline-block rounded-xl border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg no-underline transition hover:bg-surface-2"
          >
            Go to dashboard
          </NuxtLink>
        </div>

        <!-- valid invite -->
        <div v-else key="invite" class="reveal">
          <p class="text-sm font-medium tracking-wide text-accent uppercase">You're invited</p>
          <h1 class="mt-2 font-display text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
            Join {{ preview?.workspace?.name || "this workspace" }}
          </h1>
          <p class="mt-3 text-[15px] leading-relaxed text-fg-muted">
            <template v-if="preview?.inviterName">{{ preview?.inviterName }} invited you</template>
            <template v-else>You've been invited</template>
            to this workspace on Treehouse.
            <template v-if="preview?.role === 'viewer'">
              You'll be able to read its files and leave comments, but not change anything.
            </template>
            <template v-else>
              You'll share its files and sync with everyone in it — and nothing else.
            </template>
          </p>

          <div
            class="mt-7 flex items-center gap-3.5 rounded-xl border border-border bg-surface-2 px-4 py-3.5"
          >
            <WorkspaceIcon
              :icon="preview?.workspace?.icon"
              :color="preview?.workspace?.color"
              :workspace-id="preview?.workspace?.id"
              size="lg"
            />
            <div class="min-w-0">
              <p class="truncate font-medium text-fg">{{ preview?.workspace?.name }}</p>
              <p class="truncate text-sm text-fg-subtle">Workspace</p>
            </div>
          </div>

          <p v-if="error" class="mt-4 text-sm text-danger">{{ error }}</p>

          <button
            type="button"
            :disabled="accepting"
            class="mt-7 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-fg transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            @click="accept"
          >
            <svg
              v-if="accepting"
              class="h-4 w-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
            >
              <path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round" />
            </svg>
            <span>{{ accepting ? "Joining…" : "Accept invite" }}</span>
          </button>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.step-enter-active {
  transition:
    opacity 0.35s ease,
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}
.step-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.step-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.step-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.success-badge {
  animation: pop 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.success-ring {
  stroke-dasharray: 145;
  stroke-dashoffset: 145;
  animation: draw 0.55s ease-out 0.12s forwards;
}
.success-check {
  stroke-dasharray: 40;
  stroke-dashoffset: 40;
  animation: draw 0.4s ease-out 0.5s forwards;
}
.success-text {
  animation: fade-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--d, 40ms);
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.7);
  }
}
@keyframes draw {
  to {
    stroke-dashoffset: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .success-badge,
  .success-text {
    animation: none;
  }
  .success-ring,
  .success-check {
    animation: none;
    stroke-dashoffset: 0;
  }
}
</style>