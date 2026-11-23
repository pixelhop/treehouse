<script setup lang="ts">
import { CONSENT_KEY, readConsent, startPostHog } from "~/plugins/posthog.client";
import { consentToSidekick } from "~/plugins/sidekick.client";

/**
 * Analytics consent for the marketing site.
 *
 * Only rendered when there is something to consent TO: with no PostHog key
 * configured (local dev, CI, a self-hosted build) nothing is loaded, so showing
 * a cookie banner would be a lie.
 *
 * The same answer covers the affiliate referral cookie, but the banner only
 * mentions it to visitors who arrived through an affiliate link — nobody else
 * gets one (plugins/sidekick.client.ts).
 *
 * Deliberately not a "manage preferences" modal with toggles. There is exactly
 * one thing to decide here — may we measure this visit — and a two-button
 * answer respects that. Reject is a real button of equal weight, not a link
 * hidden under the fold; a dark-pattern banner on a page that talks about
 * trusting us with your files would undercut the product.
 */
const { key, host } = useRuntimeConfig().public.posthog as { key: string; host: string };

// Shared so the chat launcher's teaser can wait until the banner is answered
// instead of stacking on top of it.
const visible = useState<boolean>("cookie-banner-visible", () => false);
/** Set by plugins/sidekick.client.ts when the visitor arrived through an affiliate link. */
const referred = useState<boolean>("sidekick-referred", () => false);

onMounted(() => {
  if (!key && !referred.value) return;
  visible.value = readConsent() === null;
});

function remember(choice: "accepted" | "rejected") {
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // Storage unavailable (private browsing). The choice still applies to this
    // page load; we just cannot remember it, so they will be asked again.
  }
  visible.value = false;
}

function accept() {
  remember("accepted");
  // PostHog is not running yet — this is what starts it, so nothing at all was
  // requested or stored before this click. See plugins/posthog.client.ts.
  startPostHog(key, host);
  if (referred.value) consentToSidekick();
}

function reject() {
  // Nothing to switch off: neither PostHog nor the referral was ever started.
  // The only thing stored is the answer itself, so we stop asking.
  remember("rejected");
}
</script>

<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="translate-y-4 opacity-0"
    leave-active-class="transition duration-200 ease-in"
    leave-to-class="translate-y-4 opacity-0"
  >
    <div
      v-if="visible"
      role="dialog"
      aria-label="Cookie consent"
      class="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-2xl rounded-2xl border border-border/70 bg-parchment/95 p-4 shadow-lg backdrop-blur-sm sm:inset-x-6 sm:p-5"
    >
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p v-if="key && referred" class="text-sm text-fg-muted">
          We use
          <span class="font-semibold text-fg">PostHog</span>
          to understand how this site is used, and a cookie to credit the partner who sent you. No
          tracking until you say so.
        </p>
        <p v-else-if="referred" class="text-sm text-fg-muted">
          We use a cookie to credit the partner who sent you here. No tracking until you say so.
        </p>
        <p v-else class="text-sm text-fg-muted">
          We use
          <span class="font-semibold text-fg">PostHog</span>
          to understand how this site is used. No tracking until you say so.
        </p>
        <div class="flex shrink-0 items-center gap-2">
          <button
            type="button"
            class="min-h-11 rounded-full px-4 py-2 text-sm font-semibold text-fg-muted transition-colors hover:bg-mist hover:text-fg"
            @click="reject"
          >
            No thanks
          </button>
          <button
            type="button"
            class="lift min-h-11 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-fg hover:bg-primary-hover hover:shadow-md"
            @click="accept"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>