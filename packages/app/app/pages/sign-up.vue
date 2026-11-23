<script setup lang="ts">
const authClient = useAuthClient();
const route = useRoute();
const {
  public: { apiUrl },
} = useRuntimeConfig();

// Mid-OAuth (an agent connecting), the API answers sign-up with the consent
// page and the auth client follows it — so skip the plan step. See oauthFlow.ts.
const oauthFlow = computed(() => isOAuthFlow(route.query));

// Chromeless for the same reason as sign-in — see the note there.
definePageMeta({ layout: false });

const name = ref("");
const email = ref("");
const password = ref("");
// "How did you hear about Treehouse?": optional, an option key, plus free text
// when the answer is "Somewhere else". See utils/heardAbout.ts.
const heardChoice = ref("");
const heardOther = ref("");
// "Send me product news": unticked until the person ticks it, and only then
// do they get marketing email. The API records when they did.
const marketingOptIn = ref(false);
const loading = ref(false);
const errorMessage = ref("");
// Set once the account exists but its email is still to be confirmed: the
// page turns into "check your email" rather than signing anyone in.
const awaitingEmail = ref(false);
const resent = ref(false);

// Where the link in the verification email goes: the plan step, or mid-OAuth
// the authorization itself, so the link carries on to the consent page.
const verifiedURL = computed(() =>
  verificationCallbackURL(route.query, apiUrl, window.location.origin, "/plans"),
);

async function signUpEmail() {
  loading.value = true;
  errorMessage.value = "";
  const { data, error } = await authClient.signUp.email({
    name: name.value,
    email: email.value,
    password: password.value,
    heardAbout: heardAboutAnswer(heardChoice.value, heardOther.value),
    marketingOptIn: marketingOptIn.value,
    callbackURL: verifiedURL.value,
  });
  loading.value = false;
  if (error) errorMessage.value = error.message ?? "Unable to create account.";
  else await afterSignUp(Boolean(data.token));
}

function afterSignUp(signedIn: boolean) {
  // No session means the deployment requires a confirmed email. The API gives
  // the same answer for an address that already has an account, so this screen
  // says nothing about which it was.
  if (!signedIn) awaitingEmail.value = true;
  // Straight to the plan step, not the dashboard. The minute after signing up is
  // the one moment someone is actively deciding what this is worth to them, and
  // it used to pass in silence. `/plans` sends itself on to the dashboard when
  // the deployment has nothing to sell.
  else if (!oauthFlow.value) return navigateTo("/plans");
}

async function resend() {
  resent.value = false;
  errorMessage.value = "";
  const { error } = await authClient.sendVerificationEmail({
    email: email.value,
    callbackURL: verifiedURL.value,
  });
  if (error) {
    errorMessage.value = error.message ?? "Unable to send another email.";
    return;
  }
  resent.value = true;
}

function startOver() {
  awaitingEmail.value = false;
  resent.value = false;
  errorMessage.value = "";
  password.value = "";
}
</script>

<template>
  <AuthCanopy
    v-if="awaitingEmail"
    title="Check your email"
    :subtitle="`We've sent a link to ${email}.`"
  >
    <p class="text-center text-[15px] text-fg">
      Click it to confirm your address and finish setting up your treehouse.
    </p>

    <p v-if="errorMessage" class="mt-4 text-center text-[14px] text-danger">{{ errorMessage }}</p>

    <div class="mt-6 flex flex-col items-center gap-3 text-[14px]">
      <button
        type="button"
        class="font-semibold text-accent hover:underline"
        :disabled="resent"
        @click="resend"
      >
        {{ resent ? "Sent. Check your inbox." : "Send it again" }}
      </button>
      <button type="button" class="font-medium text-fg-muted hover:text-fg" @click="startOver">
        Use a different email
      </button>
    </div>

    <template #footer>
      Confirmed it somewhere else?
      <NuxtLink
        :to="{ path: '/sign-in', query: oauthFlowQuery(route.query) }"
        class="font-semibold text-accent no-underline hover:underline"
      >
        Sign in
      </NuxtLink>
    </template>
  </AuthCanopy>

  <AuthCanopy v-else title="Make yourself at home" subtitle="Create your Treehouse account.">
    <form class="space-y-3.5 short:space-y-2.5" @submit.prevent="signUpEmail">
      <input
        v-model="name"
        type="text"
        required
        autocomplete="name"
        placeholder="Your name"
        aria-label="Name"
        class="w-full rounded-xl border border-border bg-surface px-4 py-3 text-[15px] text-fg outline-none transition placeholder:text-fg-subtle focus:border-accent focus:ring-4 focus:ring-accent/12"
      />
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
        minlength="8"
        autocomplete="new-password"
        placeholder="Password (8+ characters)"
        aria-label="Password"
        class="w-full rounded-xl border border-border bg-surface px-4 py-3 text-[15px] text-fg outline-none transition placeholder:text-fg-subtle focus:border-accent focus:ring-4 focus:ring-accent/12"
      />
      <HeardAboutField v-model:choice="heardChoice" v-model:other="heardOther" />
      <label
        class="flex cursor-pointer items-start gap-3 px-1 pt-1 text-left text-[14px] text-fg-muted"
      >
        <input
          v-model="marketingOptIn"
          type="checkbox"
          class="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border accent-accent"
        />
        <span>Send me occasional product news and tips. You can unsubscribe at any time.</span>
      </label>

      <p v-if="errorMessage" class="text-[14px] text-danger">{{ errorMessage }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="w-full rounded-full bg-accent px-4 py-3.5 text-[15px] font-semibold text-accent-fg shadow-[0_1px_2px_rgba(35,95,68,0.4),0_10px_24px_-8px_rgba(35,95,68,0.55)] transition hover:bg-[#235F44] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {{ loading ? "Planting…" : "Plant your treehouse" }}
      </button>
    </form>

    <template #footer>
      Already have an account?
      <NuxtLink
        :to="{ path: '/sign-in', query: oauthFlowQuery(route.query) }"
        class="font-semibold text-accent no-underline hover:underline"
      >
        Sign in
      </NuxtLink>
    </template>
  </AuthCanopy>
</template>