<script setup lang="ts">
// The sentinel the desktop shell watches for. In the app, the shell cancels this
// navigation before it ever loads — the URL is a signal, not a destination.
//
// This route exists for the case where nobody is listening: a plain browser that
// somehow reaches it should land on something explicable rather than a 404. It is
// deliberately inert — the workspace was already chosen; there is nothing to redo.
definePageMeta({ middleware: "auth", layout: "onboarding" });
</script>

<template>
  <div class="flex-1 overflow-auto">
    <div class="mx-auto w-full max-w-xl px-6 py-20 text-center">
      <h1 class="font-display text-2xl font-semibold tracking-tight text-fg">
        Back to the Treehouse app
      </h1>
      <p class="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-fg-muted">
        Your workspace is selected. Switch to the Treehouse app to finish choosing where it lives on
        your Mac.
      </p>
      <NuxtLink
        to="/workspace"
        class="mt-8 inline-block rounded-xl border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg no-underline transition hover:bg-surface-2"
      >
        Open the workspace →
      </NuxtLink>
    </div>
  </div>
</template>