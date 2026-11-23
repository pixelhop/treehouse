<script setup lang="ts">
import type { OAuthConsentInfo } from "~/composables/useTreehouseApi";

// OAuth consent for an MCP client (Claude Code, claude.ai, Cursor...). The API's
// authorization endpoint sends the browser here with a signed query once the
// user is signed in. Allow hands the client its authorization code; the name
// typed here becomes the connection's label — on the change feed next to
// everything it does, and in the connected-agents list.
//
// Chromeless like sign-in: this is a step in someone else's app's flow, so the
// workspace chrome would only offer ways to wander off mid-authorization.
definePageMeta({ middleware: "auth", layout: false });

const api = useTreehouseApi();

const oauthQuery = ref("");
const info = ref<OAuthConsentInfo | null>(null);
const name = ref("");
const loadError = ref("");
const submitError = ref("");
const submitting = ref<"allow" | "deny" | null>(null);

// Read from the real URL rather than the router: the signature covers the
// query exactly as the API wrote it.
onMounted(async () => {
  oauthQuery.value = window.location.search.slice(1);
  try {
    info.value = await api.oauthConsentInfo(oauthQuery.value);
    name.value = info.value.name ?? info.value.client.name ?? "";
  } catch {
    loadError.value =
      "This connection request has expired or isn't valid. Go back to your agent and connect again.";
  }
});

const clientName = computed(() => info.value?.client.name || "An app");

async function decide(accept: boolean) {
  submitting.value = accept ? "allow" : "deny";
  submitError.value = "";
  try {
    const { url } = await api.submitOAuthConsent(oauthQuery.value, accept, name.value.trim());
    // Back to the client (often a loopback port on this machine), which shows
    // its own "you can close this tab" page.
    window.location.href = url;
  } catch (e) {
    submitting.value = null;
    submitError.value = apiErrorMessage(
      e,
      "Couldn't finish connecting. Try again from your agent.",
    );
  }
}
</script>

<template>
  <AuthCanopy
    :title="info ? `Connect ${clientName}` : 'Connect an agent'"
    subtitle="to your Treehouse"
  >
    <p v-if="loadError" class="text-[15px] text-fg-muted">{{ loadError }}</p>

    <p v-else-if="!info" class="text-[15px] text-fg-subtle">Loading…</p>

    <form v-else class="space-y-5" @submit.prevent="decide(true)">
      <div class="flex items-start gap-3">
        <img
          v-if="info.client.icon"
          :src="info.client.icon"
          alt=""
          class="mt-0.5 h-9 w-9 shrink-0 rounded-lg border border-border bg-surface object-contain"
        />
        <p class="text-[15px] leading-relaxed text-fg-muted">
          <strong class="font-semibold text-fg">{{ clientName }}</strong> will be able to read and
          change files in every workspace you belong to, as you. Its changes are marked as an
          agent's.
        </p>
      </div>

      <label class="block">
        <span class="mb-1.5 block text-[14px] font-medium text-fg">Name this connection</span>
        <input
          v-model="name"
          type="text"
          maxlength="80"
          autocomplete="off"
          placeholder="e.g. Claude Code on my laptop"
          class="w-full rounded-xl border border-border bg-surface px-4 py-3 text-[15px] text-fg outline-none transition placeholder:text-fg-subtle focus:border-accent focus:ring-4 focus:ring-accent/12"
        />
        <span class="mt-1.5 block text-[13px] text-fg-subtle">
          Shown next to everything it does, so you can tell your agents apart.
        </span>
      </label>

      <p v-if="submitError" class="text-[14px] text-danger">{{ submitError }}</p>

      <div class="space-y-2.5">
        <button
          type="submit"
          :disabled="submitting !== null"
          class="w-full rounded-full bg-accent px-4 py-3.5 text-[15px] font-semibold text-accent-fg shadow-[0_1px_2px_rgba(35,95,68,0.4),0_10px_24px_-8px_rgba(35,95,68,0.55)] transition hover:bg-[#235F44] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {{ submitting === "allow" ? "Connecting…" : "Allow" }}
        </button>
        <button
          type="button"
          :disabled="submitting !== null"
          class="w-full rounded-full px-4 py-3 text-[15px] font-medium text-fg-muted transition hover:text-fg disabled:opacity-60"
          @click="decide(false)"
        >
          Cancel
        </button>
      </div>
    </form>
  </AuthCanopy>
</template>