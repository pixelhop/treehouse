<script setup lang="ts">
// Read-only, type-aware rendering of parsed front matter as a definition list.
// Shared by the viewer card (FrontMatterCard) and the sidebar (FileInfoPanel).
// Every key and value binds as a text node — never v-html — because front matter
// is untrusted (KTD5). In a narrow container (sidebar) rows stack; in a wide one
// they lay out label-left / value-right.
import type { FrontMatterData } from "~/utils/frontmatterData";
import { frontMatterFieldKind } from "~/utils/frontmatterFields";

// `card` lays out label-left / value-right (wide viewer card); `sidebar` stacks
// label above value so long values use the full width of a narrow panel.
const props = defineProps<{ data: FrontMatterData; variant?: "card" | "sidebar" }>();
const sidebar = computed(() => props.variant === "sidebar");

const rows = computed(() =>
  Object.entries(props.data).map(([key, value]) => ({
    key,
    value,
    kind: frontMatterFieldKind(value),
  })),
);

const expandedKeys = ref(new Set<string>());
function toggleKey(key: string) {
  const next = new Set(expandedKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedKeys.value = next;
}

function scalarText(value: unknown): string {
  return value === null || value === undefined ? "—" : String(value);
}
function arrayItems(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => scalarText(v)) : [];
}
function complexText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
</script>

<template>
  <dl :class="sidebar ? 'space-y-2.5 text-sm' : 'space-y-2 text-sm'">
    <div
      v-for="row in rows"
      :key="row.key"
      :class="sidebar ? 'flex flex-col gap-0.5' : 'flex flex-col gap-1 sm:flex-row sm:gap-3'"
    >
      <dt
        :class="
          sidebar
            ? 'text-xs font-medium text-fg-subtle'
            : 'shrink-0 font-medium text-fg-subtle sm:w-32 sm:text-right'
        "
      >
        {{ row.key }}
      </dt>
      <dd class="min-w-0 flex-1 text-fg">
        <!-- arrays → chips -->
        <span v-if="row.kind === 'array'" class="flex flex-wrap gap-1">
          <span
            v-for="(item, i) in arrayItems(row.value)"
            :key="i"
            class="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg-muted"
            >{{ item }}</span
          >
        </span>
        <!-- complex / nested → muted text block (text-bound, never v-html) -->
        <pre
          v-else-if="row.kind === 'complex'"
          class="overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-xs text-fg-muted"
          >{{ complexText(row.value) }}</pre>
        <!-- scalar / boolean / date → text, clamped when long -->
        <span v-else>
          <span
            :class="[
              'whitespace-pre-wrap break-words',
              !expandedKeys.has(row.key) && 'line-clamp-2',
            ]"
            >{{ scalarText(row.value) }}</span
          >
          <button
            v-if="scalarText(row.value).length > 120"
            type="button"
            class="mt-0.5 block text-xs text-accent hover:underline"
            @click="toggleKey(row.key)"
          >
            {{ expandedKeys.has(row.key) ? "Show less" : "Show more" }}
          </button>
        </span>
      </dd>
    </div>
  </dl>
</template>