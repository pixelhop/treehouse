<script setup lang="ts">
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import {
  DEFAULT_THEME,
  applyTheme,
  buildThemeCss,
  parseThemeCss,
  sanitizeThemeCss,
  snapshotThemeCss,
  THEME_TOKENS,
  type ThemeChoice,
  useTheme,
} from "~/composables/useTheme";

const open = defineModel<boolean>("open", { default: false });

const ws = useWorkspaceData();
const api = useTreehouseApi();
const qc = useQueryClient();
const theme = useTheme();

const draft = ref<ThemeChoice>({ theme: DEFAULT_THEME });
const vars = ref<Record<string, string>>({});
const rawCss = ref("");
const advanced = ref(false);

// Seed the draft from the effective theme each time the dialog opens.
watch(open, (o) => {
  if (!o) return;
  const eff = theme.effective.value;
  draft.value = { theme: eff.theme, themeCss: eff.themeCss };
  if (eff.theme === "custom" && eff.themeCss) {
    vars.value = parseThemeCss(eff.themeCss);
    rawCss.value = eff.themeCss;
    advanced.value = false;
  }
});

function selectPreset(id: string) {
  draft.value = { theme: id };
  applyTheme(draft.value); // live preview
}
function startCustom() {
  const css = snapshotThemeCss(); // start from whatever's currently applied
  vars.value = parseThemeCss(css);
  rawCss.value = buildThemeCss(vars.value);
  draft.value = { theme: "custom", themeCss: rawCss.value };
  applyTheme(draft.value);
}
function onVar(v: string, value: string) {
  vars.value = { ...vars.value, [v]: value };
  rawCss.value = buildThemeCss(vars.value);
  draft.value = { theme: "custom", themeCss: rawCss.value };
  applyTheme(draft.value);
}
function onRaw(value: string) {
  rawCss.value = value; // keep the user's text as-typed for editing
  vars.value = parseThemeCss(value);
  // Persist only the sanitized form; applyTheme also sanitizes for preview.
  draft.value = { theme: "custom", themeCss: buildThemeCss(vars.value) };
  applyTheme({ theme: "custom", themeCss: value });
}

const isCustom = computed(() => draft.value.theme === "custom");

function close() {
  open.value = false;
  applyTheme(theme.effective.value); // discard preview
}
function useForMe() {
  theme.setOverride(draft.value);
  open.value = false;
}

const saveDefault = useMutation({
  mutationFn: () =>
    api.updateWorkspace(ws.workspaceId.value as string, {
      theme: draft.value.theme,
      themeCss:
        draft.value.theme === "custom" ? sanitizeThemeCss(draft.value.themeCss ?? "") : null,
    }),
  onSuccess: () => {
    theme.clearOverride(); // adopt the new default
    void qc.invalidateQueries({ queryKey: ["workspace-meta"] });
    void qc.invalidateQueries({ queryKey: ["workspaces"] });
    open.value = false;
  },
});

function followDefault() {
  theme.clearOverride();
  open.value = false;
}

const overridden = computed(() => !!theme.currentOverride.value);
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    @click.self="close"
  >
    <div
      class="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
    >
      <div class="border-b border-border px-6 py-4">
        <p class="text-xs uppercase tracking-[0.2em] text-fg-subtle">Appearance</p>
        <h3 class="text-lg font-semibold text-fg">Theme</h3>
        <p class="mt-0.5 text-xs text-fg-muted">
          For
          <span class="font-medium text-fg">{{
            ws.workspace.value?.name ?? "this workspace"
          }}</span>
          <template v-if="overridden">
            · personal override ·
            <button type="button" class="text-accent hover:underline" @click="followDefault">
              follow workspace default
            </button>
          </template>
        </p>
      </div>

      <div class="space-y-5 overflow-auto px-6 py-5">
        <!-- presets -->
        <div class="grid grid-cols-2 gap-2">
          <button
            v-for="p in theme.presets"
            :key="p.id"
            type="button"
            class="flex items-center gap-3 rounded-lg border p-2.5 text-left transition"
            :class="
              !isCustom && draft.theme === p.id
                ? 'border-accent ring-1 ring-accent'
                : 'border-border hover:bg-surface-2'
            "
            @click="selectPreset(p.id)"
          >
            <span class="flex h-8 w-8 shrink-0 overflow-hidden rounded-md border border-border">
              <span v-for="c in p.swatch" :key="c" class="flex-1" :style="{ background: c }" />
            </span>
            <span class="text-sm font-medium text-fg">{{ p.label }}</span>
          </button>

          <!-- custom -->
          <button
            type="button"
            class="flex items-center gap-3 rounded-lg border p-2.5 text-left transition"
            :class="
              isCustom ? 'border-accent ring-1 ring-accent' : 'border-border hover:bg-surface-2'
            "
            @click="startCustom"
          >
            <span
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-fg-subtle"
            >
              <NodeIcon icon="solar:palette-bold-duotone" :is-dir="false" class="h-4 w-4" />
            </span>
            <span class="text-sm font-medium text-fg">Custom…</span>
          </button>
        </div>

        <!-- custom editor -->
        <div v-if="isCustom" class="space-y-3 border-t border-border pt-4">
          <div class="flex items-center justify-between">
            <p class="text-xs font-medium uppercase tracking-wider text-fg-subtle">Colours</p>
            <button
              type="button"
              class="text-xs text-accent hover:underline"
              @click="advanced = !advanced"
            >
              {{ advanced ? "Use colour pickers" : "Edit raw CSS" }}
            </button>
          </div>

          <div v-if="!advanced" class="grid grid-cols-2 gap-x-4 gap-y-2">
            <label
              v-for="t in THEME_TOKENS"
              :key="t.var"
              class="flex items-center gap-2 text-xs text-fg-muted"
            >
              <input
                type="color"
                class="h-6 w-6 shrink-0 cursor-pointer rounded border border-border bg-surface"
                :value="vars[t.var] || '#000000'"
                @input="onVar(t.var, ($event.target as HTMLInputElement).value)"
              />
              <span class="truncate">{{ t.label }}</span>
            </label>
          </div>

          <textarea
            v-else
            :value="rawCss"
            rows="10"
            spellcheck="false"
            class="w-full rounded-md border border-border bg-app p-3 font-mono text-xs text-fg outline-none focus:border-accent"
            placeholder="--th-app: #0a0a0a;&#10;--th-fg: #fafafa;"
            @input="onRaw(($event.target as HTMLTextAreaElement).value)"
          />
          <p class="text-xs text-fg-subtle">
            Any of the <code>--th-*</code> variables. Unset ones fall back to the default theme.
          </p>
        </div>
      </div>

      <!-- actions -->
      <div class="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-fg-muted transition hover:bg-surface-2"
          @click="close"
        >
          Cancel
        </button>
        <button
          v-if="!ws.viewOnly.value"
          type="button"
          :disabled="saveDefault.isPending.value"
          class="rounded-md border border-border px-3 py-1.5 text-sm whitespace-nowrap text-fg transition hover:bg-surface-2 disabled:opacity-50"
          title="Set as the default everyone in this workspace sees"
          @click="saveDefault.mutate()"
        >
          Set as default
        </button>
        <button
          type="button"
          class="rounded-md bg-accent px-4 py-1.5 text-sm font-medium whitespace-nowrap text-accent-fg transition hover:opacity-90"
          @click="useForMe"
        >
          Use for me
        </button>
      </div>
    </div>
  </div>
</template>