<script setup lang="ts">
// Never renders: `landing` redirects every visitor — into their workspace when
// signed in, to sign-in otherwise.
definePageMeta({ middleware: "landing" });
</script>

<template>
  <div />
</template>