<script setup lang="ts">
// Where the link in the verification email lands. The API has already checked
// the token and signed the person in by now, so a good link just passes
// through to `next`. A bad one arrives with `?error=` (expired, already used,
// or for an account that no longer exists), and the only fix is a fresh link,
// which signing in sends.
definePageMeta({ layout: false });

const route = useRoute();
const failed = typeof route.query.error === "string";

if (!failed) {
  const next = typeof route.query.next === "string" ? route.query.next : "";
  // Same-app paths only: this page is a redirect, and its query comes from a link.
  const safe = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\");
  await navigateTo(safe ? next : "/workspace", { replace: true });
}
</script>

<template>
  <AuthCanopy
    v-if="failed"
    title="That link didn't work"
    subtitle="It may have expired, or already been used."
  >
    <p class="text-center text-[15px] text-fg">
      Sign in with your email and password, and we'll send you a fresh one.
    </p>
    <NuxtLink
      to="/sign-in"
      class="mt-6 block w-full rounded-full bg-accent px-4 py-3.5 text-center text-[15px] font-semibold text-accent-fg no-underline shadow-[0_1px_2px_rgba(35,95,68,0.4),0_10px_24px_-8px_rgba(35,95,68,0.55)] transition hover:bg-[#235F44]"
    >
      Sign in
    </NuxtLink>
  </AuthCanopy>
</template>