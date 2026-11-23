<script setup lang="ts">
const authClient = useAuthClient();
const route = useRoute();
const {
  public: { apiUrl },
} = useRuntimeConfig();

// Chromeless. The `default` layout puts "Sign in / Sign up" nav in the corner of
// the sign-in page, which is a link to where you already are; the canopy is the
// whole frame here. No theme watch either — a signed-out visitor has no active
// workspace, so the `:root` brand palette is the only correct answer.
definePageMeta({ layout: false });

const email = ref("");
const password = ref("");
const loading = ref(false);
const errorMessage = ref("");
// The account exists and the password was right, but the email address has not
// been confirmed yet. A fresh link has just been sent.
const unverified = ref(false);

// Signing back in lands in the workspace you last had open, matching what
// opening the app does. /workspace falls back to the dashboard for accounts
// that don't have a workspace yet.
const redirectTo = computed(() => (route.query.redirect as string) || "/workspace");

// Mid-OAuth (an agent connecting), the API answers sign-in with the consent
// page and the auth client follows it — so don't also navigate. See oauthFlow.ts.
const oauthFlow = computed(() => isOAuthFlow(route.query));

// Only reachable with the right password, so this tells nobody anything they
// didn't know. The link lands where this sign-in was going.
async function askForFreshLink() {
  await authClient.sendVerificationEmail({
    email: email.value,
    callbackURL: verificationCallbackURL(
      route.query,
      apiUrl,
      window.location.origin,
      redirectTo.value,
    ),
  });
  unverified.value = true;
}

async function onSignInError(error: { code?: string; message?: string }) {
  if (error.code === "EMAIL_NOT_VERIFIED") return askForFreshLink();
  errorMessage.value = error.message ?? "Unable to sign in.";
}

async function signInEmail() {
  loading.value = true;
  errorMessage.value = "";
  unverified.value = false;
  const { error } = await authClient.signIn.email({
    email: email.value,
    password: password.value,
  });
  if (error) await onSignInError(error);
  loading.value = false;
  if (!error && !oauthFlow.value) await navigateTo(redirectTo.value);
}
</script>

<template>
  <AuthCanopy
    title="Welcome home"
    :subtitle="oauthFlow ? 'Sign in to connect your agent to Treehouse.' : 'Sign in to Treehouse.'"
  >
    <form class="space-y-3.5 short:space-y-2.5" @submit.prevent="signInEmail">
      <input
        v-model="email"
        type="email"
        required
        autocomplete="email"
        placeholder="you@company.com"
        aria-label="Email"
        class="w-full rounded-xl border border-border bg-surface px-4 py-3 text-[15px] text-fg outline-none transition placeholder:text-fg-subtle focus:border-accent focus:ring-4 focus:ring-accent/12"
      />
      <input
        v-model="password"
        type="password"
        required
        autocomplete="current-password"
        placeholder="Password"
        aria-label="Password"
        class="w-full rounded-xl border border-border bg-surface px-4 py-3 text-[15px] text-fg outline-none transition placeholder:text-fg-subtle focus:border-accent focus:ring-4 focus:ring-accent/12"
      />

      <p v-if="unverified" class="text-[14px] text-fg">
        Confirm your email first. We've sent a new link to
        <span class="font-medium">{{ email }}</span
        >.
      </p>
      <p v-if="errorMessage" class="text-[14px] text-danger">{{ errorMessage }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="w-full rounded-full bg-accent px-4 py-3.5 text-[15px] font-semibold text-accent-fg shadow-[0_1px_2px_rgba(35,95,68,0.4),0_10px_24px_-8px_rgba(35,95,68,0.55)] transition hover:bg-[#235F44] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {{ loading ? "Climbing in…" : "Climb in" }}
      </button>
    </form>

    <p class="mt-4 text-center">
      <NuxtLink
        to="/forgot-password"
        class="text-[13px] font-medium text-fg-muted no-underline hover:text-fg"
      >
        Forgot your password?
      </NuxtLink>
    </p>

    <template #footer>
      No account yet?
      <NuxtLink
        :to="{ path: '/sign-up', query: oauthFlowQuery(route.query) }"
        class="font-semibold text-accent no-underline hover:underline"
      >
        Plant one
      </NuxtLink>
    </template>
  </AuthCanopy>
</template>