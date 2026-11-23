<script setup lang="ts">
import logoUrl from "design/assets/logo/treehouse.svg";
const year = new Date().getFullYear();

const authClient = useAuthClient();
const session = authClient.useSession();

async function signOut() {
  await authClient.signOut();
  await navigateTo("/sign-in");
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-app text-fg">
    <header class="border-b border-border bg-surface">
      <div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <!-- Mark + wordmark, nothing else. /design.md: "No tagline in any lockup" —
             the two-line version put "Shared file workspace" in the wordmark slot,
             which read as the product's name rather than a description of it. -->
        <NuxtLink to="/" class="flex items-center gap-2.5 no-underline">
          <img :src="logoUrl" alt="" aria-hidden="true" class="h-9 w-9 shrink-0" />
          <span class="wordmark text-xl text-fg">Treehouse</span>
          <BetaBadge />
        </NuxtLink>
        <nav class="flex items-center gap-3 text-sm">
          <template v-if="session.data">
            <NuxtLink to="/dashboard" class="text-fg-muted no-underline hover:text-fg"
              >Dashboard</NuxtLink
            >
            <NuxtLink to="/workspace" class="text-fg-muted no-underline hover:text-fg"
              >Workspace</NuxtLink
            >
            <button
              type="button"
              class="rounded-md border border-border px-3 py-1.5 text-fg transition hover:bg-surface-2"
              @click="signOut"
            >
              Sign out
            </button>
          </template>
          <template v-else>
            <NuxtLink to="/sign-in" class="text-fg-muted no-underline hover:text-fg"
              >Sign in</NuxtLink
            >
            <NuxtLink
              to="/sign-up"
              class="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg no-underline transition hover:bg-accent/90"
              >Sign up</NuxtLink
            >
          </template>
          <slot name="header-actions" />
        </nav>
      </div>
    </header>
    <main class="mx-auto w-full max-w-6xl flex-1 px-6 py-12">
      <slot />
    </main>
    <footer class="border-t border-border bg-surface">
      <div class="mx-auto max-w-6xl px-6 py-4 text-sm text-fg-muted">
        Treehouse · agent-native shared file workspace · {{ year }}
      </div>
    </footer>
  </div>
</template>