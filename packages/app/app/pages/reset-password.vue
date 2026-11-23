<script setup lang="ts">
const authClient = useAuthClient();
const route = useRoute();

// better-auth redirects here after validating the email link:
//   /reset-password?token=<token>   (or ?error=INVALID_TOKEN on a bad/expired link)
// route.query values are string | string[] | null — a duplicated param arrives
// as an array, so take the first entry rather than asserting `as string`.
function firstQuery(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}
const token = computed(() => firstQuery(route.query.token));
const linkError = computed(() => firstQuery(route.query.error));

const password = ref("");
const confirm = ref("");
const loading = ref(false);
const errorMessage = ref("");
const done = ref(false);

async function resetPassword() {
  errorMessage.value = "";
  if (password.value !== confirm.value) {
    errorMessage.value = "Passwords don't match.";
    return;
  }
  loading.value = true;
  const { error } = await authClient.resetPassword({
    newPassword: password.value,
    token: token.value,
  });
  loading.value = false;
  if (error) {
    errorMessage.value = error.message ?? "Unable to reset password.";
    return;
  }
  done.value = true;
}
</script>

<template>
  <section class="mx-auto max-w-md space-y-6">
    <div>
      <h2 class="font-display text-2xl font-semibold text-fg">Reset password</h2>
      <p class="mt-1 text-sm text-fg-muted">Choose a new password for your account.</p>
    </div>

    <div v-if="done" class="space-y-3 rounded-xl border border-border bg-surface p-6 shadow-sm">
      <p class="text-sm text-fg">Your password has been reset.</p>
      <NuxtLink to="/sign-in" class="inline-block text-sm text-accent hover:underline">
        Sign in
      </NuxtLink>
    </div>

    <div
      v-else-if="linkError || !token"
      class="space-y-3 rounded-xl border border-border bg-surface p-6 shadow-sm"
    >
      <p class="text-sm text-danger">This password reset link is invalid or has expired.</p>
      <NuxtLink to="/forgot-password" class="inline-block text-sm text-accent hover:underline">
        Request a new link
      </NuxtLink>
    </div>

    <form
      v-else
      class="space-y-4 rounded-xl border border-border bg-surface p-6 shadow-sm"
      @submit.prevent="resetPassword"
    >
      <label class="block space-y-1">
        <span class="text-sm text-fg">New password</span>
        <input
          v-model="password"
          type="password"
          required
          minlength="8"
          autocomplete="new-password"
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
      </label>
      <label class="block space-y-1">
        <span class="text-sm text-fg">Confirm new password</span>
        <input
          v-model="confirm"
          type="password"
          required
          minlength="8"
          autocomplete="new-password"
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
      </label>

      <p v-if="errorMessage" class="text-sm text-danger">{{ errorMessage }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-60"
      >
        {{ loading ? "Resetting…" : "Reset password" }}
      </button>
    </form>
  </section>
</template>