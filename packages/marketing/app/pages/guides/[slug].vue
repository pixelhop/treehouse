<script lang="ts" setup>
// /guides/<slug>, from content/pages/guides/*.md. Same template as the
// comparisons, because these readers aren't on Treehouse yet either.
const { doc, page } = await useLandingPage();
</script>

<template>
  <LandingArticle :doc="doc" :page="page" />
</template>