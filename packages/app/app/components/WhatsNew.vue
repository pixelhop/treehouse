<script setup lang="ts">
import IconWhatsNew from "~icons/solar/stars-minimalistic-linear";
import { hopdateTheme, resolveCssColor } from "~/utils/hopdate";

// "What's new": Treehouse release notes from Hopdate (https://hopdate.pixelhop.io).
// The embed script renders the panel and the new-release popup in a Shadow DOM,
// opens the panel from any [data-hopdate] element and fills [data-hopdate-badge]
// with the unread count. Entries and auto-open live in the Hopdate dashboard;
// this component only feeds it the workspace's current palette.

interface HopdateTheme {
  mode: "light" | "dark";
  primaryColor: string;
}
interface HopdateInstance {
  setTheme(theme: HopdateTheme): void;
}
interface HopdateGlobal {
  init(config: { projectKey: string; apiUrl: string; theme?: HopdateTheme }): HopdateInstance;
  instance: HopdateInstance | null;
}

const SCRIPT_ID = "hopdate-sdk";

const { hopdate: config } = useRuntimeConfig().public;
const theme = useTheme();
// Hidden when unconfigured (local dev, self-hosted), or when the embed can't
// load (blocked, offline), so nobody sees a button that does nothing.
const unavailable = ref(false);
const enabled = computed(() => Boolean(config.projectKey && config.apiUrl) && !unavailable.value);

function hopdateGlobal() {
  return (window as unknown as { Hopdate?: HopdateGlobal }).Hopdate;
}

function loadScript(): Promise<HopdateGlobal | undefined> {
  const loaded = hopdateGlobal();
  if (loaded) return Promise.resolve(loaded);
  return new Promise((resolve, reject) => {
    let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = `${config.apiUrl}/embed.js`;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", () => resolve(hopdateGlobal()), { once: true });
    script.addEventListener("error", () => reject(new Error("Hopdate embed failed to load")), {
      once: true,
    });
  });
}

function currentTheme(): HopdateTheme | undefined {
  const accent = resolveCssColor("var(--th-accent)");
  const surface = resolveCssColor("var(--th-surface)");
  return accent && surface ? hopdateTheme(accent, surface) : undefined;
}

function syncTheme() {
  const palette = currentTheme();
  if (palette) hopdateGlobal()?.instance?.setTheme(palette);
}

async function start() {
  const hopdate = await loadScript();
  // The sidebar remounts as you move between pages; the widget is created once
  // and keeps working across that, so later mounts only sync the palette.
  if (hopdate?.instance) return syncTheme();
  hopdate?.init({ projectKey: config.projectKey, apiUrl: config.apiUrl, theme: currentTheme() });
}

onMounted(() => {
  if (!enabled.value) return;
  start().catch(() => {
    unavailable.value = true;
  });
});

// The layout applies the theme in its own watcher; wait for that to land in the
// DOM before reading the resolved colours back.
watch(theme.effective, () => nextTick(syncTheme), { deep: true });
</script>

<template>
  <!-- Shaped by the caller (the sidebar footer's icon row). -->
  <button v-if="enabled" type="button" data-hopdate title="What's new">
    <IconWhatsNew class="h-4 w-4" />
    <span class="sr-only">What's new</span>
    <!-- Filled and shown by the embed when there are unread releases. -->
    <span
      data-hopdate-badge
      hidden
      class="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 py-px text-center text-[10px] font-semibold leading-3 text-accent-fg ring-2 ring-surface-2"
    />
  </button>
</template>