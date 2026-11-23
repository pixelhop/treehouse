<script setup lang="ts">
// Sign-up's optional "How did you hear about Treehouse?": a short list, plus
// the person's own words when it was somewhere else. The parent turns the two
// into the stored answer with `heardAboutAnswer` (utils/heardAbout.ts).
const choice = defineModel<string>("choice", { required: true });
const other = defineModel<string>("other", { required: true });
</script>

<template>
  <div class="relative">
    <select
      v-model="choice"
      aria-label="How did you hear about Treehouse? (optional)"
      class="w-full appearance-none rounded-xl border border-border bg-surface py-3 pr-10 pl-4 text-[15px] outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/12"
      :class="choice ? 'text-fg' : 'text-fg-subtle'"
    >
      <option value="">How did you hear about us? (optional)</option>
      <option v-for="o in HEARD_ABOUT_OPTIONS" :key="o.value" :value="o.value" class="text-fg">
        {{ o.label }}
      </option>
    </select>
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      class="pointer-events-none absolute top-1/2 right-4 h-4 w-4 -translate-y-1/2 text-fg-subtle"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
    >
      <path d="m5 8 5 5 5-5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </div>
  <input
    v-if="choice === 'other'"
    v-model="other"
    type="text"
    maxlength="200"
    placeholder="Where? (optional)"
    aria-label="Where did you hear about Treehouse?"
    class="w-full rounded-xl border border-border bg-surface px-4 py-3 text-[15px] text-fg outline-none transition placeholder:text-fg-subtle focus:border-accent focus:ring-4 focus:ring-accent/12"
  />
</template>