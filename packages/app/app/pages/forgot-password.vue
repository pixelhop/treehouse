<script setup lang="ts">
const authClient = useAuthClient();

const email = ref("");
const loading = ref(false);
const errorMessage = ref("");
const sent = ref(false);

async function requestReset() {
  loading.value = true;
  errorMessage.value = "";
  // redirectTo is where better-auth sends the user after it validates the token
  // in the email link — our /reset-password page, which reads `?token=`.
  const { error } = await authClient.requestPasswordReset({
    email: email.value,
    redirectTo: `${window.location.origin}/reset-password`,
  });
  loading.value = false;
  if (error) {
    errorMessage.value = error.message ?? "Unable to send reset email.";
    return;
  }
  // The API responds the same way whether or not the email exists, so we always
  // show the neutral confirmation (no account enumeration).
  sent.value = true;
}
</script>

<template>
  <section class="mx-auto max-w-md space-y-6">
    <div>
      <h2 class="font-display text-2xl font-semibold text-fg">Forgot password</h2>
      <p class="mt-1 text-sm text-fg-muted">
        Enter your email and we'll send you a link to reset your password.
      </p>
    </div>

    <div v-if="sent" class="space-y-3 rounded-xl border border-border bg-surface p-6 shadow-sm">
      <p class="text-sm text-fg">
        If an account exists for <span class="font-medium">{{ email }}</span
        >, a password reset link is on its way. Check your inbox.
      </p>
      <NuxtLink to="/sign-in" class="inline-block text-sm text-accent hover:underline">
        Back to sign in
      </NuxtLink>
    </div>

    <form
      v-else
      class="space-y-4 rounded-xl border border-border bg-surface p-6 shadow-sm"
      @submit.prevent="requestReset"
    >
      <label class="block space-y-1">
        <span class="text-sm text-fg">Email</span>
        <input
          v-model="email"
          type="email"
          required
          autocomplete="email"
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
      </label>

      <p v-if="errorMessage" class="text-sm text-danger">{{ errorMessage }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-60"
      >
        {{ loading ? "Sending…" : "Send reset link" }}
      </button>
    </form>

    <p v-if="!sent" class="text-sm text-fg-muted">
      Remembered it?
      <NuxtLink to="/sign-in" class="text-accent hover:underline">Sign in</NuxtLink>
    </p>
  </section>
</template>