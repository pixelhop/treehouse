<script setup lang="ts">
// Structured editor for front-matter values, shown above the WYSIWYG body so a
// human can change metadata without hand-editing YAML. Controlled component: it
// reflects `data` and emits the next object on every edit; serialization back
// into the file buffer happens in the parent (FileEditor). Scope is bounded
// (KTD4): scalars, booleans, dates, and scalar arrays are editable; nested /
// complex values and adding/removing top-level keys are read-only and defer to
// source mode. Every value binds to an input value — never v-html (KTD5).
import type { FrontMatterData } from "~/utils/frontmatterData";
import { frontMatterFieldKind } from "~/utils/frontmatterFields";

const props = defineProps<{ data: FrontMatterData }>();
const emit = defineEmits<{ "update:data": [value: FrontMatterData]; "edit-source": [] }>();

// Stable per-instance ids so each field label is associated with its input.
const uid = useId();
const fieldId = (index: number) => `${uid}-fm-${index}`;

const rows = computed(() =>
  Object.entries(props.data).map(([key, value]) => ({
    key,
    value,
    kind: frontMatterFieldKind(value),
  })),
);

// Collapsed by default so the surface doesn't dominate the top of the editor;
// the bar shows a short summary and expands to the editable fields.
const expanded = ref(false);
const summary = computed(() => {
  const bits: string[] = [];
  for (const r of rows.value) {
    if (r.kind === "scalar" || r.kind === "date" || r.kind === "boolean")
      bits.push(String(r.value));
    if (bits.length >= 2) break;
  }
  return bits.join(" · ");
});

// In-progress text for each array's "add item" input.
const drafts = ref<Record<string, string>>({});

function setKey(key: string, value: unknown) {
  emit("update:data", { ...props.data, [key]: value });
}

// Edit a scalar text field. Preserve a numeric field's type when the new text is
// a number whose canonical form round-trips exactly (e.g. "42") — this keeps the
// common integer case from silently becoming a quoted string, without ever
// rewriting the input mid-keystroke (which would jump the cursor). Anything else
// (text, an in-progress decimal like "5.") is stored as the literal string.
function setScalar(key: string, original: unknown, raw: string) {
  const num = Number(raw);
  if (
    typeof original === "number" &&
    raw.trim() !== "" &&
    Number.isFinite(num) &&
    String(num) === raw.trim()
  ) {
    setKey(key, num);
  } else {
    setKey(key, raw);
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function removeItem(key: string, index: number) {
  const next = asArray(props.data[key]).slice();
  next.splice(index, 1);
  setKey(key, next);
}
function addItem(key: string) {
  const text = (drafts.value[key] ?? "").trim();
  if (text === "") return;
  setKey(key, [...asArray(props.data[key]), text]);
  drafts.value[key] = "";
}

function itemText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
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
  <section
    v-if="rows.length"
    class="border-b border-border bg-surface-2/40"
    aria-label="Edit document metadata"
  >
    <button
      type="button"
      class="flex w-full items-center gap-2 px-6 py-2 text-left text-xs text-fg-subtle transition hover:bg-surface-2/60"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="text-fg-muted">{{ expanded ? "▾" : "▸" }}</span>
      <span class="font-medium text-fg-muted">Metadata</span>
      <template v-if="summary && !expanded">
        <span>·</span>
        <span class="truncate text-fg-muted">{{ summary }}</span>
      </template>
      <span class="ml-auto shrink-0"
        >{{ rows.length }} {{ rows.length === 1 ? "field" : "fields" }}</span
      >
    </button>
    <div v-if="expanded" class="space-y-2.5 border-t border-border px-6 py-4">
      <div v-for="(row, i) in rows" :key="row.key" class="flex flex-col gap-1 sm:flex-row sm:gap-3">
        <label
          :for="row.kind !== 'complex' ? fieldId(i) : undefined"
          class="shrink-0 pt-1.5 text-sm font-medium text-fg-subtle sm:w-32 sm:text-right"
          >{{ row.key }}</label
        >
        <div class="min-w-0 flex-1">
          <!-- boolean → toggle -->
          <div v-if="row.kind === 'boolean'" class="inline-flex items-center gap-2 pt-1.5 text-sm">
            <input
              :id="fieldId(i)"
              type="checkbox"
              :checked="row.value === true"
              @change="setKey(row.key, ($event.target as HTMLInputElement).checked)"
            />
            <span class="text-fg-muted">{{ row.value === true ? "true" : "false" }}</span>
          </div>

          <!-- scalar array → removable chips + add input -->
          <div v-else-if="row.kind === 'array'" class="flex flex-wrap items-center gap-1">
            <span
              v-for="(item, i) in asArray(row.value)"
              :key="i"
              class="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg-muted"
            >
              {{ itemText(item) }}
              <button
                type="button"
                class="text-fg-subtle hover:text-danger"
                :aria-label="`Remove ${itemText(item)}`"
                @click="removeItem(row.key, i)"
              >
                ✕
              </button>
            </span>
            <input
              :id="fieldId(i)"
              :value="drafts[row.key] ?? ''"
              placeholder="Add…"
              class="w-24 rounded-md border border-border bg-app px-2 py-0.5 text-xs text-fg outline-none focus:border-accent"
              @input="drafts[row.key] = ($event.target as HTMLInputElement).value"
              @keydown.enter.prevent="addItem(row.key)"
              @blur="addItem(row.key)"
            />
          </div>

          <!-- complex / nested → read-only, defer to source mode -->
          <div v-else-if="row.kind === 'complex'">
            <pre
              class="overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-xs text-fg-muted"
              >{{ complexText(row.value) }}</pre>
            <button
              type="button"
              class="mt-0.5 text-xs text-accent hover:underline"
              @click="emit('edit-source')"
            >
              Edit in source mode
            </button>
          </div>

          <!-- scalar / date → text input -->
          <input
            v-else
            :id="fieldId(i)"
            :value="itemText(row.value)"
            :placeholder="row.kind === 'date' ? 'YYYY-MM-DD' : 'empty'"
            class="w-full rounded-md border border-border bg-app px-2 py-1 text-sm text-fg outline-none focus:border-accent"
            @input="setScalar(row.key, row.value, ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>

      <p class="pt-1 text-xs text-fg-subtle">
        To add or remove fields, or edit nested values,
        <button type="button" class="text-accent hover:underline" @click="emit('edit-source')">
          edit in source mode</button
        >.
      </p>
    </div>
  </section>
</template>