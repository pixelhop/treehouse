<script setup lang="ts">
/**
 * "Ask Treehouse" — the Chat Thing support bot, bottom right of every marketing
 * and docs page.
 *
 * Nothing from Chat Thing loads until the visitor presses the button. Same
 * posture as the analytics (plugins/posthog.client.ts): a visitor who never
 * asks a question makes no request to a third party. Chat Thing's own site
 * loads its widget on first scroll instead, which would do exactly that here.
 *
 * The button is ours, not the widget's. The SDK adopts it as its trigger
 * (`selectors.widgetTrigger`), so after the first click it owns the toggling
 * and reports open/closed through `aria-pressed`, which is watched to swap the
 * icon. An adopted trigger gets no loading state from the SDK, so the spinner
 * between the first click and the window appearing is drawn here.
 *
 * A teaser bubble invites people to ask, a few seconds in. It is drawn here
 * too, not by the SDK's own message preview, because that preview only exists
 * once the script has loaded, and the script waits for a click. Closing the
 * bubble, or opening the chat, retires it for good on this device. It waits
 * while the cookie banner is up, so the two never stack in the corner. Phones
 * never get it: at that width it lands on top of the page's own copy.
 *
 * Client-only (.client): it is fixed UI with no content worth prerendering,
 * and the docs pages are server-rendered.
 */
const LAUNCHER_ID = "treehouse-chat-launcher";
/** Remembers that this visitor has closed the teaser or opened the chat. */
const TEASER_DISMISSED_KEY = "treehouse:chat-teaser-dismissed";
/** Long enough to read the page first; short enough to still be there. */
const TEASER_DELAY_MS = 6000;
/** Below this the bubble covers the hero copy, so the button alone will do. */
const TEASER_MIN_WIDTH = "(min-width: 640px)";

const { botId, scriptUrl } = useRuntimeConfig().public.chatThing as {
  botId: string;
  scriptUrl: string;
};

const button = ref<HTMLButtonElement>();
/** The script has been requested. Reset if it fails, so a click retries. */
const requested = ref(false);
/** The script has run and the SDK has adopted the button. */
const adopted = ref(false);
/** Waiting for the window to appear after asking the SDK to open it. */
const opening = ref(false);
/** Mirrors the SDK's `aria-pressed` on the button. */
const open = ref(false);

const route = useRoute();
const onDocs = computed(() => route.path === "/docs" || route.path.startsWith("/docs/"));
/** Set by CookieBanner.vue while it is on screen. */
const cookieBannerVisible = useState<boolean>("cookie-banner-visible", () => false);
const teaserDue = ref(false);
const teaserDismissed = ref(readTeaserDismissed());
const showTeaser = computed(
  () => teaserDue.value && !teaserDismissed.value && !requested.value && !cookieBannerVisible.value,
);

function readTeaserDismissed(): boolean {
  try {
    return localStorage.getItem(TEASER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissTeaser() {
  teaserDismissed.value = true;
  try {
    localStorage.setItem(TEASER_DISMISSED_KEY, "1");
  } catch {
    // Storage unavailable (private browsing): it stays closed for this page.
  }
}

let teaserTimer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  if (teaserDismissed.value || !window.matchMedia(TEASER_MIN_WIDTH).matches) return;
  teaserTimer = setTimeout(() => (teaserDue.value = true), TEASER_DELAY_MS);
});
onBeforeUnmount(() => clearTimeout(teaserTimer));

// A watch, not onMounted: Nuxt's .client wrapper renders a placeholder on the
// first mount, so the button does not exist yet when onMounted runs.
watch(button, (el, _old, onCleanup) => {
  if (!el) return;
  const observer = new MutationObserver(() => {
    open.value = el.getAttribute("aria-pressed") === "true";
    if (open.value) opening.value = false;
  });
  observer.observe(el, { attributes: true, attributeFilter: ["aria-pressed"] });
  onCleanup(() => observer.disconnect());
});

function load() {
  requested.value = true;
  opening.value = true;

  window.chatThingConfig = {
    botId,
    theme: "light",
    selectors: { widgetTrigger: `#${LAUNCHER_ID}` },
    // Brand leaf, from packages/design/src/tokens.css.
    colour: { primaryColour: "#2e7d58", primaryColourInverted: "#ffffff" },
    // Phones get the chat full screen, over this button, so it needs its own
    // way out.
    closeChatButton: true,
  };

  const script = document.createElement("script");
  script.src = scriptUrl;
  script.async = true;
  script.onload = () => {
    adopted.value = true;
    // The SDK bound its click handler after this click was dispatched, so
    // open the window for it. It waits for the chat to be ready by itself.
    window.chatThing?.show();
  };
  script.onerror = () => {
    // Blocked or offline. Put the button back so the next click tries again.
    script.remove();
    requested.value = false;
    opening.value = false;
  };
  document.body.appendChild(script);
}

function onClick() {
  if (!requested.value) {
    // They have found the chat; no need to point at it again.
    dismissTeaser();
    load();
    return;
  }
  // Once adopted, the SDK's own listener handles this click. A click while the
  // window is still on its way cancels that open in the SDK, so drop the
  // spinner with it.
  if (adopted.value && opening.value) opening.value = false;
}
</script>

<template>
  <Transition
    enter-active-class="transition duration-300 ease-out motion-reduce:transition-none"
    enter-from-class="translate-y-2 opacity-0"
    leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
    leave-to-class="translate-y-2 opacity-0"
  >
    <div
      v-if="botId && showTeaser"
      data-chat-teaser
      class="fixed right-5 bottom-[92px] z-40 w-[min(18rem,calc(100vw-2.5rem))] rounded-2xl border border-border bg-surface shadow-lg"
    >
      <button
        type="button"
        class="block w-full rounded-2xl py-3.5 pr-10 pl-4 text-left transition-colors hover:bg-mist/50"
        @click="onClick"
      >
        <span class="block text-sm font-bold text-fg">Ask Treehouse</span>
        <span class="mt-0.5 block text-sm leading-snug text-fg-muted">
          {{
            onDocs
              ? "Can't find what you need? Ask me and I'll point you to the right page."
              : "Questions about Treehouse? Ask me. I've read every page of the docs."
          }}
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        class="absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-mist hover:text-fg"
        @click="dismissTeaser"
      >
        <svg
          viewBox="0 0 24 24"
          class="size-4"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <!-- The tail, pointing down at the launcher. -->
      <span
        class="absolute -bottom-[7px] right-[24px] size-3 rotate-45 border-r border-b border-border bg-surface"
        aria-hidden="true"
      />
    </div>
  </Transition>

  <button
    v-if="botId"
    :id="LAUNCHER_ID"
    ref="button"
    type="button"
    :aria-label="open ? 'Close chat' : 'Ask Treehouse a question'"
    :title="open ? undefined : 'Ask Treehouse a question'"
    :aria-busy="opening"
    class="lift fixed right-5 bottom-5 z-40 inline-flex size-[60px] items-center justify-center rounded-full bg-primary text-primary-fg shadow-lg hover:bg-primary-hover hover:shadow-xl"
    @click="onClick"
  >
    <span
      v-if="opening"
      class="size-6 animate-spin rounded-full border-[2.5px] border-primary-fg/35 border-t-primary-fg"
      aria-hidden="true"
    />
    <svg
      v-else-if="open"
      viewBox="0 0 24 24"
      class="size-7"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
    <svg v-else viewBox="0 0 24 24" class="size-7" aria-hidden="true">
      <!-- Solar chat-round-dots-bold, with the dots cut out (evenodd) rather
           than masked, so they always show the button colour underneath. -->
      <path
        fill="currentColor"
        fill-rule="evenodd"
        d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2S2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22M15 12a1 1 0 1 0 2 0a1 1 0 0 0-2 0m-4 0a1 1 0 1 0 2 0a1 1 0 0 0-2 0m-4 0a1 1 0 1 0 2 0a1 1 0 0 0-2 0"
      />
    </svg>
  </button>
</template>