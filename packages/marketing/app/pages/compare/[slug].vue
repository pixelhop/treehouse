<script lang="ts" setup>
// /compare/<competitor>, from content/pages/compare/*.md. Prerendered.
const { doc, page } = await useLandingPage();
</script>

<template>
  <LandingArticle :doc="doc" :page="page" />
</template>