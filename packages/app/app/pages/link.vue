<script setup lang="ts">
import type { WorkspaceInfo } from "~/composables/useTreehouseApi";
import leafSprigUrl from "design/assets/motif/leaf-sprig.svg";
import mascotFilesUrl from "design/assets/raster/mascot-files.webp";
import { hashParam, sentinelUrl } from "~/utils/connect";
import { ancestorFolders } from "~/utils/treehouse";
import {
  classifyArch,
  detectOS,
  isLinkAppMode,
  linkCopy,
  linkKeyName,
  preselectedWorkspaceId,
  requestedWorkspaceId,
  type DetectedOS,
  COMING_SOON_NOTE,
} from "~/utils/desktopApp";

// Device-code onboarding. The CLI prints a user_code and opens /link?code=XXXX;
// the user confirms the code matches their terminal, picks a workspace, and
// approval mints a scoped key that's delivered back to the waiting terminal.
//
// App mode (`?app=1&workspace=<id>`): the desktop shell drives the same grant in
// its authed webview — it preselects the workspace and swaps the terminal-flavored
// copy. Without `app`, this page behaves exactly as before.
// `layout: false` + an explicit <NuxtLayout> below: the layout depends on the query
// (app mode), and `setPageLayout` turned out to STICK past this page — "Open the
// workspace" then rendered the workspace without its sidebar.
definePageMeta({ middleware: "auth", layout: false });

const route = useRoute();
const api = useTreehouseApi();

const DL = "https://dl.trytree.house";

// App mode + its copy — resolved once from the query.
const appMode = isLinkAppMode(route.query);

// In app mode this is the last step of the desktop app's onboarding, so it takes
// the onboarding layout like the steps before it. The workspace chrome showed the
// sidebar and files of whatever workspace was open LAST — on a second setup,
// "Acme is growing" sat beside a different workspace's name and file tree, and the
// sidebar offered a way out mid-grant.
const layoutName = appMode ? "onboarding" : "app";

// The code-verification screen exists so a user can check the code on screen
// against the one in their TERMINAL. Inside the desktop app there is no terminal
// and no second device: the shell generated this code and opened this page in its
// own window, so there is nothing to compare against and the workspace was already
// chosen two steps ago. There, confirm the thing that is actually worth confirming
// — this workspace, into that folder — and drop the ceremony.
//
// Gated on the SHELL, not on ?app=1. Anyone can put ?app=1 on a link; letting the
// marker alone skip the code check would hand a phishing page a way past it.
const inShell = ref(false);
const folderName = ref<string | null>(null);
onMounted(() => {
  inShell.value = isDesktopShell();
  folderName.value = hashParam(window.location.hash, "folder");
});
/** Show the short confirmation instead of the code check. */
const shellConfirm = computed(() => inShell.value && appMode);
const copy = linkCopy(appMode);

type Step = "install" | "run" | "approve" | "success";

const code = ref(((route.query.code as string) ?? "").toUpperCase());

// Returning users (who've installed before) skip straight to the run step.
const installedBefore = (() => {
  try {
    return localStorage.getItem("th_cli_installed") === "1";
  } catch {
    return false;
  }
})();
const step = ref<Step>(route.query.code ? "approve" : installedBefore ? "run" : "install");

const workspaces = ref<WorkspaceInfo[]>([]);
const selectedId = ref("");
const loadingWorkspaces = ref(true);
const submitting = ref(false);
const error = ref("");
const copied = ref(false);
const copiedInstall = ref(false);
const showAllPlatforms = ref(false);
const manualCode = ref("");

// Shown command — the folder is a placeholder the user swaps for their own.
const command = "treehouse login ~/my-folder";

// ── Platform detection — pick the right install one-liner for this machine ──
// Shared with the invite page's desktop-app offer (see ~/utils/desktopApp).
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

// Architecture is best-effort: only Chromium exposes it (async, below); on other
// browsers it stays "unknown" and we show the command anyway (install.sh checks
// the real arch on-device and errors cleanly on unsupported combos).
const osArch = ref<"arm64" | "x64" | "unknown">("unknown");

const platform = computed(() => {
  const shCmd = `curl -fsSL ${DL}/install.sh | sh`;
  const a = osArch.value;
  switch (detectedOS) {
    case "mac":
      return {
        label: a === "x64" ? "macOS · Intel" : a === "arm64" ? "macOS · Apple Silicon" : "macOS",
        command: shCmd,
        supported: a !== "x64",
        note:
          a === "x64" ? "Intel Macs aren't supported yet — the build is Apple-Silicon-only." : "",
      };
    case "windows":
    case "linux":
      // These builds exist but have never been tested, so they aren't offered.
      return {
        label: detectedOS === "windows" ? "Windows" : "Linux",
        command: "",
        supported: false,
        note: COMING_SOON_NOTE,
      };
    case "mobile":
      return {
        label: "a phone or tablet",
        command: "",
        supported: false,
        note: "Treehouse syncs a folder on a computer — open this page on your desktop or laptop to get started.",
      };
    default:
      return { label: "your computer", command: shCmd, supported: true, note: "" };
  }
});

// Split "KP3H-KZMJ" into groups of characters for the verification display.
const codeChars = computed(() =>
  code.value
    .replace(/\s+/g, "")
    .split("-")
    .filter(Boolean)
    .map((group) => group.split("")),
);

onMounted(async () => {
  // Refine the architecture where the browser exposes it (Chromium only).
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

  // App mode with a requested workspace: resolve it AUTHORITATIVELY by id (a
  // membership-checked lookup), NOT from the active-org-scoped list. The webview's
  // session has its own active org (often the user's personal one, not the invited
  // org), so the invited workspace may be absent from listWorkspaces() — trusting
  // that list would preselect nothing and then auto-select the WRONG lone workspace,
  // driving the grant into a guaranteed mint→revoke→retry loop. We never auto-select
  // a workspace different from the requested one; a lookup failure is an access error.
  const requested = appMode ? requestedWorkspaceId(route.query) : "";
  if (appMode && requested) {
    try {
      const ws = await api.getWorkspaceById(requested);
      workspaces.value = [ws];
      selectedId.value = ws.id;
    } catch (e) {
      const status = statusOf(e);
      error.value =
        status === 403 || status === 404
          ? "You don't have access to this workspace yet."
          : "We couldn't load that workspace.";
    } finally {
      loadingWorkspaces.value = false;
    }
    return;
  }

  try {
    const res = await api.listWorkspaces();
    workspaces.value = res.workspaces;
    // Preselect the requested workspace when it's one of theirs (the CLI's
    // `--workspace`, which an agent setting up a workspace passes), else
    // auto-select a lone workspace. Only a default: the person still checks the
    // code and can choose another.
    const preselected = preselectedWorkspaceId(
      route.query,
      res.workspaces.map((w) => w.id),
    );
    if (preselected) selectedId.value = preselected;
    else if (res.workspaces.length === 1 && res.workspaces[0])
      selectedId.value = res.workspaces[0].id;
  } catch {
    error.value = "We couldn't load your workspaces.";
  } finally {
    loadingWorkspaces.value = false;
  }
});

function statusOf(e: unknown): number | undefined {
  return (e as { statusCode?: number }).statusCode ?? (e as { status?: number }).status;
}

async function copyInstall() {
  try {
    await navigator.clipboard.writeText(platform.value.command);
    copiedInstall.value = true;
    setTimeout(() => {
      copiedInstall.value = false;
    }, 1600);
  } catch {
    // clipboard blocked — the user can select the text manually
  }
}

function markInstalled() {
  try {
    localStorage.setItem("th_cli_installed", "1");
  } catch {
    // private mode / storage disabled — fine, just advance
  }
  step.value = "run";
}

async function copyCommand() {
  try {
    await navigator.clipboard.writeText(command);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch {
    // clipboard blocked — the user can select the text manually
  }
}

function continueWithCode() {
  const entered = manualCode.value.trim().toUpperCase();
  if (!entered) {
    error.value = "Enter the code shown in your terminal.";
    return;
  }
  code.value = entered;
  error.value = "";
  step.value = "approve";
}

async function connect() {
  error.value = "";
  if (!selectedId.value) {
    error.value = "Choose a workspace to sync into.";
    return;
  }
  submitting.value = true;
  try {
    // In app mode, forward the honest key label ("Treehouse Desktop") so app-minted
    // keys are distinguishable from CLI keys in key management (U4).
    const keyName = appMode ? linkKeyName(route.query) : undefined;
    await api.approveDevice(code.value.trim(), selectedId.value, "human", keyName, {
      access: keyAccess.value,
      ...(keyFolder.value ? { folder: keyFolder.value } : {}),
    });
    step.value = "success";
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode ?? (e as { status?: number }).status;
    error.value =
      status === 403
        ? "You're not a member of that workspace."
        : status === 404
          ? "That code is invalid or has expired — start again in your terminal."
          : "That didn't work — the code may have expired. Try again from your terminal.";
  } finally {
    submitting.value = false;
  }
}

const selectedWorkspace = computed(() => workspaces.value.find((w) => w.id === selectedId.value));

// What this device may do. Off to one side of the main choice: most people are
// connecting their own computer and want everything, so the default is to leave
// it alone. The folders are fetched only for someone who opens it.
const keyAccess = ref<"write" | "read">("write");
const keyFolder = ref("");
const limitsOpen = ref(false);
const limitFolders = ref<string[]>([]);
const limitsSet = computed(() => keyAccess.value === "read" || !!keyFolder.value);
// Only a different workspace clears the folder: collapsing the section must not
// quietly turn a limited key back into a full one.
watch(selectedId, () => {
  keyFolder.value = "";
  limitFolders.value = [];
});
watch([limitsOpen, selectedId], async ([open, id]) => {
  if (!open || !id) return;
  const { entries } = await api.list(id);
  if (id !== selectedId.value) return; // switched workspace while this loaded
  limitFolders.value = [...new Set(entries.flatMap((e) => ancestorFolders(e.path)))].sort();
});

// After a successful setup in the app: the account's OTHER workspaces that have no
// folder on this Mac yet. Onboarding used to end at exactly one workspace, so
// someone who already had several (made on the web before installing the app) had
// to discover the menubar's "Add a Folder…" to bring the rest home.
// Fetched separately: in app mode `workspaces` holds only the one being linked.
const desktopFolders = useDesktopFolders();
const accountWorkspaces = ref<WorkspaceInfo[]>([]);
const alsoSync = computed(() =>
  accountWorkspaces.value.filter(
    (w) => w.id !== selectedId.value && !desktopFolders.folderFor(w.id),
  ),
);
watch(step, async (s) => {
  if (s !== "success" || !shellConfirm.value) return;
  await desktopFolders.refresh();
  try {
    accountWorkspaces.value = (await api.listWorkspaces()).workspaces;
  } catch {
    // Optional extra — the setup that just finished is what matters.
  }
});
const syncingNext = ref("");

/** Hand the next workspace to the shell — the same sentinel the workspace step
 * uses, so it enters the same flow. A full navigation, which is what the shell's
 * will-navigate listener hears (a router push would not fire it). */
function syncNext(workspaceId: string) {
  syncingNext.value = workspaceId;
  window.location.assign(sentinelUrl(window.location.origin, workspaceId));
}
</script>

<template>
  <NuxtLayout :name="layoutName">
    <!-- Not in app mode: the bar's sidebar toggle controls a sidebar the onboarding
       layout doesn't render (and silently flips the workspace's own panel state). -->
    <AppTopBar v-if="!appMode" title="Connect" />

    <div class="flex-1 overflow-auto">
      <div class="mx-auto w-full max-w-xl px-6 py-12 sm:py-20">
        <Transition name="step" mode="out-in">
          <!-- ───────────────────────── Step 0 — install the app ───────────────────────── -->
          <div v-if="step === 'install'" key="install" class="reveal">
            <p class="text-sm font-medium tracking-wide text-accent uppercase">Get started</p>
            <h1 class="mt-2 font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Install Treehouse
            </h1>
            <p class="mt-3 max-w-prose text-[15px] leading-relaxed text-fg-muted">
              One command installs Treehouse on your computer, then keeps a folder in sync with this
              workspace&nbsp;— the same files you and your agents both work on.
            </p>

            <div class="mt-9">
              <!-- detected platform -->
              <div class="mb-3 flex items-center gap-2 text-sm text-fg-subtle">
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
                  >Detected <span class="font-medium text-fg">{{ platform.label }}</span></span
                >
              </div>

              <template v-if="platform.supported">
                <!-- install command block -->
                <div
                  class="group flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3.5 font-mono text-sm"
                >
                  <span aria-hidden="true" class="select-none text-fg-subtle">$</span>
                  <code class="flex-1 truncate text-fg">{{ platform.command }}</code>
                  <button
                    type="button"
                    class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-app hover:text-fg"
                    :aria-label="copiedInstall ? 'Copied' : 'Copy command'"
                    @click="copyInstall"
                  >
                    <svg
                      v-if="!copiedInstall"
                      class="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <rect x="9" y="9" width="11" height="11" rx="2.5" />
                      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                    </svg>
                    <svg
                      v-else
                      class="h-3.5 w-3.5 text-success"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    <span :class="copiedInstall ? 'text-success' : ''">{{
                      copiedInstall ? "Copied" : "Copy"
                    }}</span>
                  </button>
                </div>
                <p class="mt-3 text-[13px] leading-relaxed text-fg-subtle">
                  Downloads the latest build for your machine and verifies its checksum before
                  installing&nbsp;— nothing runs as admin.
                </p>
              </template>

              <!-- unsupported platform (Intel Mac, Windows, Linux, mobile) -->
              <div
                v-else
                class="flex items-start gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3.5 text-sm text-fg-muted"
              >
                <svg
                  class="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8h.01M11 12h1v4h1" />
                </svg>
                <span>{{ platform.note }}</span>
              </div>
            </div>

            <!-- other platforms -->
            <button
              type="button"
              class="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-fg-muted transition hover:text-fg"
              @click="showAllPlatforms = !showAllPlatforms"
            >
              <svg
                class="h-3.5 w-3.5 transition-transform"
                :class="showAllPlatforms ? 'rotate-90' : ''"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              Other platforms
            </button>
            <div v-if="showAllPlatforms" class="reveal mt-3 space-y-3">
              <div>
                <p class="mb-1.5 text-xs font-medium text-fg-subtle">macOS · Apple silicon</p>
                <div
                  class="truncate rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-[13px] text-fg"
                >
                  curl -fsSL {{ DL }}/install.sh | sh
                </div>
              </div>
              <p class="text-xs text-fg-subtle">Windows and Linux are coming soon.</p>
            </div>

            <!-- continue -->
            <div class="mt-10 flex items-center justify-between border-t border-border pt-6">
              <p class="text-sm text-fg-muted">Already installed?</p>
              <button
                type="button"
                class="rounded-lg px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/10"
                @click="markInstalled"
              >
                I've installed it →
              </button>
            </div>
          </div>

          <!-- ───────────────────────── Step 1 — run the command ───────────────────────── -->
          <div v-else-if="step === 'run'" key="run" class="reveal">
            <button
              type="button"
              class="group -ml-1 inline-flex items-center gap-1 text-sm font-medium tracking-wide text-fg-subtle uppercase transition hover:text-accent"
              @click="step = 'install'"
            >
              <svg
                class="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m15 6-6 6 6 6" />
              </svg>
              Install
            </button>
            <h1 class="mt-2 font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Connect a folder
            </h1>
            <p class="mt-3 max-w-prose text-[15px] leading-relaxed text-fg-muted">
              Run one command and a folder on your machine stays in sync with this workspace&nbsp;—
              the same files you and your agents both work on.
            </p>

            <div class="mt-9 space-y-3">
              <div class="flex items-center gap-2 text-sm font-medium text-fg-subtle">
                <span
                  class="grid h-5 w-5 place-items-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent"
                  >1</span
                >
                In your terminal, run
              </div>

              <!-- command block -->
              <div
                class="group flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3.5 font-mono text-sm"
              >
                <span aria-hidden="true" class="select-none text-fg-subtle">$</span>
                <code class="flex-1 truncate text-fg">{{ command }}</code>
                <button
                  type="button"
                  class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-app hover:text-fg"
                  :aria-label="copied ? 'Copied' : 'Copy command'"
                  @click="copyCommand"
                >
                  <svg
                    v-if="!copied"
                    class="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect x="9" y="9" width="11" height="11" rx="2.5" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                  <svg
                    v-else
                    class="h-3.5 w-3.5 text-success"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span :class="copied ? 'text-success' : ''">{{
                    copied ? "Copied" : "Copy"
                  }}</span>
                </button>
              </div>

              <div class="flex items-center gap-2 text-sm font-medium text-fg-subtle">
                <span
                  class="grid h-5 w-5 place-items-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent"
                  >2</span
                >
                A short code appears — we'll bring you right back here
              </div>
            </div>

            <!-- already have a code -->
            <div class="mt-10 border-t border-border pt-6">
              <p class="text-sm text-fg-muted">Already see a code in your terminal?</p>
              <div class="mt-3 flex gap-2">
                <input
                  v-model="manualCode"
                  placeholder="XXXX-XXXX"
                  autocomplete="off"
                  spellcheck="false"
                  class="w-44 rounded-lg border border-border bg-surface px-3 py-2 text-center font-mono tracking-[0.2em] text-fg uppercase outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                  @keyup.enter="continueWithCode"
                />
                <button
                  type="button"
                  class="rounded-lg px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/10"
                  @click="continueWithCode"
                >
                  Continue →
                </button>
              </div>
              <p v-if="error" class="mt-2 text-sm text-danger">{{ error }}</p>
            </div>
          </div>

          <!-- ─────────────────────── Step 2 — verify + choose ─────────────────────── -->
          <div v-else-if="step === 'approve'" key="approve" class="reveal">
            <h1 class="font-display text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
              {{ shellConfirm ? "Ready to sync" : copy.approveTitle }}
            </h1>
            <p class="mt-2 text-[15px] text-fg-muted">
              {{
                shellConfirm
                  ? "One last check before Treehouse starts keeping these in step."
                  : copy.approveSubtitle
              }}
            </p>

            <!-- In the shell: name the workspace AND the folder, which is the thing
               worth confirming and the thing the old screen could not show. -->
            <div
              v-if="shellConfirm"
              class="mt-8 rounded-xl border border-border bg-surface-2 px-5 py-4 text-[15px]"
            >
              <div class="flex items-center gap-3">
                <WorkspaceIcon
                  v-if="selectedWorkspace"
                  :icon="selectedWorkspace.icon"
                  :color="selectedWorkspace.color"
                  :workspace-id="selectedWorkspace.id"
                  size="lg"
                />
                <span class="font-medium text-fg">{{ selectedWorkspace?.name }}</span>
              </div>
              <div v-if="folderName" class="mt-3 flex items-baseline gap-2 text-fg-muted">
                <span class="text-fg-subtle">syncs into</span>
                <span class="font-mono text-[13px] text-fg">{{ folderName }}</span>
              </div>
            </div>

            <!-- code verification chips -->
            <div v-if="!shellConfirm" class="mt-7 flex items-center justify-center gap-2 sm:gap-3">
              <template v-for="(group, gi) in codeChars" :key="gi">
                <span v-if="gi > 0" aria-hidden="true" class="text-xl text-fg-subtle">–</span>
                <span
                  v-for="(ch, ci) in group"
                  :key="`${gi}-${ci}`"
                  class="grid h-12 w-10 place-items-center rounded-lg border border-border bg-surface-2 font-mono text-2xl font-medium text-fg sm:h-14 sm:w-12"
                  >{{ ch }}</span
                >
              </template>
            </div>

            <!-- workspace picker — redundant in the shell, where it was chosen two
               steps ago and is already shown above. -->
            <p v-if="!shellConfirm" class="mt-9 mb-3 text-sm font-medium text-fg-subtle">
              Sync into
            </p>

            <div v-if="shellConfirm" class="hidden" />
            <div v-else-if="loadingWorkspaces" class="space-y-2">
              <div v-for="i in 2" :key="i" class="h-16 animate-pulse rounded-xl bg-surface-2" />
            </div>

            <div
              v-else-if="workspaces.length === 0"
              class="rounded-xl border border-border bg-surface p-5 text-sm text-fg-muted"
            >
              You don't have a workspace yet.
              <NuxtLink to="/workspace" class="font-medium text-accent">Create one →</NuxtLink>
            </div>

            <div v-else class="space-y-2">
              <button
                v-for="w in workspaces"
                :key="w.id"
                type="button"
                class="flex w-full items-center gap-3.5 rounded-xl border px-4 py-3 text-left transition"
                :class="
                  selectedId === w.id
                    ? 'border-accent bg-accent/5 ring-1 ring-accent'
                    : 'border-border bg-surface hover:bg-surface-2'
                "
                @click="selectedId = w.id"
              >
                <WorkspaceIcon :icon="w.icon" :color="w.color" :workspace-id="w.id" size="lg" />
                <span class="flex-1 font-medium text-fg">{{ w.name }}</span>
                <svg
                  v-if="selectedId === w.id"
                  class="h-5 w-5 text-accent"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </button>
            </div>

            <details
              v-if="selectedId"
              class="mt-4"
              @toggle="limitsOpen = ($event.target as HTMLDetailsElement).open"
            >
              <summary class="cursor-pointer text-sm text-fg-muted">
                Limit what this device can do
                <span v-if="limitsSet" class="text-fg-subtle">(limits set)</span>
              </summary>
              <KeyScopeFields
                v-model:access="keyAccess"
                v-model:folder="keyFolder"
                class="mt-3"
                :folders="limitFolders"
              />
            </details>

            <p v-if="error" class="mt-4 text-sm text-danger">{{ error }}</p>

            <button
              type="button"
              :disabled="submitting || !selectedId"
              class="mt-7 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-fg transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              @click="connect"
            >
              <svg
                v-if="submitting"
                class="h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round" />
              </svg>
              <span>{{
                submitting
                  ? "Connecting…"
                  : selectedWorkspace
                    ? `Connect to ${selectedWorkspace.name}`
                    : "Connect"
              }}</span>
            </button>
          </div>

          <!-- ───────────────────────────── Step 3 — success ───────────────────────────── -->
          <!-- In the shell this is the end of onboarding, so it gets the celebration
             /design.md reserves for a big completion: the mascot, the workspace
             named, where it lives, and a single leaf-fall drift. Everywhere else
             the terminal is still the destination, so the quieter original stands. -->
          <div
            v-else-if="shellConfirm"
            key="success-app"
            class="relative flex flex-col items-center overflow-hidden pt-4 text-center"
          >
            <span
              v-for="i in 6"
              :key="i"
              class="th-leaf"
              :style="`--th-i:${i}; left:${8 + i * 13}%`"
              aria-hidden="true"
            >
              <img :src="leafSprigUrl" alt="" class="h-6 w-6" />
            </span>

            <img :src="mascotFilesUrl" alt="" class="th-grow-in h-44 w-auto object-contain" />
            <h1
              class="th-rise mt-6 font-display text-[40px] leading-tight font-semibold tracking-tight text-fg"
              style="--th-delay: 120ms"
            >
              {{ selectedWorkspace?.name }} is growing
            </h1>
            <p
              v-if="folderName"
              class="th-rise mt-3 font-mono text-[13px] text-fg-muted"
              style="--th-delay: 200ms"
            >
              {{ folderName }}
            </p>
            <p
              class="th-rise mt-4 max-w-sm text-[15px] leading-relaxed text-fg-muted"
              style="--th-delay: 260ms"
            >
              Drop a file in and it shows up here; change it here and it lands on your computer.
            </p>
            <!-- Address the workspace the user just linked, not "/workspace" — that
               is a back-compat redirect which resolves to the LAST-OPENED or first
               workspace, so it could land somewhere else entirely, and reliably did
               for an invited workspace that had never been opened. -->
            <NuxtLink
              :to="selectedId ? `/w/${selectedId}` : '/workspace'"
              class="th-rise mt-8 rounded-full bg-accent px-7 py-3 text-sm font-semibold text-accent-fg no-underline transition hover:bg-accent/90"
              style="--th-delay: 320ms"
            >
              Open the workspace
            </NuxtLink>

            <!-- The rest of the account, offered while the user is still in setup
               mode rather than left for them to find in the menu bar. -->
            <div
              v-if="desktopFolders.available.value && alsoSync.length"
              class="th-rise mt-12 w-full max-w-md text-left"
              style="--th-delay: 400ms"
            >
              <p class="text-sm font-medium text-fg-subtle">
                Also bring {{ alsoSync.length === 1 ? "this" : "these" }} home?
              </p>
              <div class="mt-3 space-y-2">
                <div
                  v-for="w in alsoSync"
                  :key="w.id"
                  class="flex items-center gap-3.5 rounded-xl border border-border bg-surface px-4 py-3"
                >
                  <WorkspaceIcon :icon="w.icon" :color="w.color" :workspace-id="w.id" size="md" />
                  <span class="flex-1 truncate text-[15px] font-medium text-fg">{{ w.name }}</span>
                  <button
                    type="button"
                    :disabled="!!syncingNext"
                    class="rounded-full border border-accent px-4 py-1.5 text-sm font-medium text-accent transition hover:bg-accent/5 disabled:opacity-50"
                    @click="syncNext(w.id)"
                  >
                    {{ syncingNext === w.id ? "Opening…" : "Sync" }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div v-else key="success" class="flex flex-col items-center pt-6 text-center">
            <span
              class="success-badge grid h-20 w-20 place-items-center rounded-full bg-success/10"
            >
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

            <h1
              class="success-text mt-7 font-display text-3xl font-semibold tracking-tight text-fg"
            >
              {{ copy.successTitle }}
            </h1>
            <p
              class="success-text mt-3 max-w-sm text-[15px] leading-relaxed text-fg-muted"
              style="--d: 90ms"
            >
              {{ copy.successBody }}
            </p>

            <NuxtLink
              to="/workspace"
              class="success-text mt-8 rounded-xl border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg no-underline transition hover:bg-surface-2"
              style="--d: 180ms"
            >
              Open the workspace →
            </NuxtLink>
          </div>
        </Transition>
      </div>
    </div>
  </NuxtLayout>
</template>

<style scoped>
/* Step transition (out-in). */
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

/* Success choreography: badge pops, ring + check draw, text rises. */
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