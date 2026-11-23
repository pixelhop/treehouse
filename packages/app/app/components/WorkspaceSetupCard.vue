<script setup lang="ts">
// Vendor marks from simple-icons. `currentColor` is inherited from the button,
// so each logo picks up the button's own foreground rather than the brand colour
// — the row stays one visual family instead of three competing logos, and dark
// mode needs no special casing.
import IconClaude from "~icons/simple-icons/claude";
import IconOpenAI from "~icons/simple-icons/openai";
import IconCheck from "~icons/solar/check-circle-bold";
import IconCopy from "~icons/solar/copy-linear";
import IconMagic from "~icons/solar/magic-stick-3-linear";
import { buildSetupLinks, buildSetupPrompt } from "~/utils/setupPrompt";

// The hand-off card on an un-set-up workspace: one click to get whichever agent
// the user already has pointed at the seeded AGENTS.md setup guide.
//
// It shows ONLY while the workspace still looks un-set-up (the caller decides
// via needsSetup()) — inside the workspace view at its root, and on the
// dashboard. Once folders exist it is gone for good from both — mirroring the
// self-retirement built into AGENTS.md itself. Onboarding chrome that outstays
// its welcome is a defect this repo has shipped before; this card is built to
// leave.
//
// Vertical spacing belongs to the caller: the two surfaces stack it differently,
// so the card carries none of its own.
const props = defineProps<{
  workspaceName: string;
  workspaceId: string;
  folderName?: string | null;
}>();

const {
  public: { apiUrl },
} = useRuntimeConfig();

const prompt = computed(() =>
  buildSetupPrompt({
    workspaceName: props.workspaceName,
    workspaceId: props.workspaceId,
    appOrigin: window.location.origin,
    apiBase: apiUrl as string,
    folderName: props.folderName ?? null,
  }),
);
const links = computed(() => buildSetupLinks(prompt.value));

const copied = ref(false);
const copyFailed = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function copyPrompt() {
  copyFailed.value = false;
  try {
    await navigator.clipboard.writeText(prompt.value);
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch {
    // Clipboard can be blocked (insecure context, permissions). Say so rather
    // than leaving the button looking like it worked — the prompt is revealed
    // below so it can still be selected by hand.
    copyFailed.value = true;
    showPrompt.value = true;
  }
}

onBeforeUnmount(() => clearTimeout(copyTimer));

const showPrompt = ref(false);
</script>

<template>
  <section
    class="rounded-2xl border border-accent/30 bg-accent/5 p-6"
    aria-labelledby="setup-card-heading"
  >
    <div class="flex items-start gap-3">
      <IconMagic class="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
      <div class="min-w-0">
        <h2 id="setup-card-heading" class="text-lg font-semibold text-fg">
          Let an agent set this up
        </h2>
        <p class="mt-1.5 text-sm leading-relaxed text-fg-muted">
          It'll get this workspace syncing to your computer if it isn't already, ask what it's for,
          and build a folder structure once you approve.
        </p>
      </div>
    </div>

    <div class="mt-5 flex flex-wrap items-center gap-2">
      <!-- Each link is absent only when the prompt is too long to carry; Copy
           prompt still works, so the card degrades rather than dies. Claude Code
           leads: it can run the whole thing, connecting the folder included. -->
      <a
        v-if="links.claudeCode"
        :href="links.claudeCode"
        class="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg no-underline transition hover:bg-accent/90"
      >
        <IconClaude class="h-4 w-4" aria-hidden="true" />
        Claude Code
      </a>
      <a
        v-if="links.cowork"
        :href="links.cowork"
        class="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium text-fg no-underline transition hover:border-accent/60"
      >
        <IconClaude class="h-4 w-4 text-fg-muted" aria-hidden="true" />
        Claude Cowork
      </a>
      <a
        v-if="links.codex"
        :href="links.codex"
        class="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium text-fg no-underline transition hover:border-accent/60"
      >
        <IconOpenAI class="h-4 w-4 text-fg-muted" aria-hidden="true" />
        Codex
      </a>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium text-fg transition hover:border-accent/60"
        @click="copyPrompt"
      >
        <component
          :is="copied ? IconCheck : IconCopy"
          class="h-4 w-4"
          :class="copied ? 'text-accent' : 'text-fg-subtle'"
          aria-hidden="true"
        />
        {{ copied ? "Copied" : "Copy prompt" }}
      </button>
    </div>

    <!-- The buttons open apps on this computer. Saying so up front is kinder
         than a click that silently does nothing. -->
    <p class="mt-3 text-xs leading-relaxed text-fg-subtle">
      Opens the app on this computer with the prompt ready to send. Another agent? Copy the prompt.
    </p>

    <p v-if="copyFailed" class="mt-2 text-xs text-warning">
      Couldn't reach the clipboard — select the prompt below and copy it manually.
    </p>

    <button
      type="button"
      class="mt-3 text-xs font-medium text-fg-subtle underline underline-offset-2 transition hover:text-fg-muted"
      :aria-expanded="showPrompt"
      @click="showPrompt = !showPrompt"
    >
      {{ showPrompt ? "Hide prompt" : "See the prompt" }}
    </button>
    <pre
      v-if="showPrompt"
      class="mt-2 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg-muted"
      >{{ prompt }}</pre>
  </section>
</template>