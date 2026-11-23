<script setup lang="ts">
// Lightweight CodeMirror 6 editor for plain-text / code files, and the source
// mode of the markdown editor. Mounted imperatively (CM owns its own state) and
// torn down on unmount. Themed via the workspace --th-* tokens so it follows
// every preset + custom theme. Granular CM imports (no `codemirror` meta) keep
// the Worker bundle lean.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { cmLanguageId, type CmLanguageId } from "~/utils/codeLanguage";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    path?: string;
    contentType?: string;
    readonly?: boolean;
  }>(),
  { path: "", contentType: "", readonly: false },
);
const emit = defineEmits<{ "update:modelValue": [value: string]; save: [] }>();

const host = ref<HTMLElement | null>(null);
// Not reactive — CM's EditorView is a mutable controller, not Vue state.
let view: EditorView | undefined;
const language = new Compartment();
const editable = new Compartment();

// One loader per CodeMirror id in the code-language table. Typed by that table,
// so an id without a grammar here fails the typecheck. The grammars ship with
// the (lazy-loaded) editor, never with the viewers.
const CM_LANGUAGES: Record<CmLanguageId, () => Extension> = {
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  yaml: () => yaml(),
  markdown: () => markdown(),
  html: () => html(),
  css: () => css(),
};

function languageExtension(): Extension {
  const id = cmLanguageId(props.path, props.contentType);
  return id ? CM_LANGUAGES[id]() : [];
}

// CSS-variable theme so the editor inherits the active workspace theme.
const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "0.8125rem",
    color: "var(--th-fg)",
    backgroundColor: "transparent",
  },
  ".cm-content": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    caretColor: "var(--th-fg)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--th-fg-subtle)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--th-accent) 22%, transparent)",
  },
});

function buildExtensions(): Extension[] {
  return [
    lineNumbers(),
    history(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    // Save shortcut — intercept Mod-s so the browser save dialog never appears.
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (emit("save"), true) },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    theme,
    language.of(languageExtension()),
    editable.of(EditorView.editable.of(!props.readonly)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) emit("update:modelValue", u.state.doc.toString());
    }),
  ];
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    state: EditorState.create({ doc: props.modelValue, extensions: buildExtensions() }),
    parent: host.value,
  });
  // Same reasoning as MarkdownEditor: this only mounts because someone asked to
  // edit (or switched to source), so hand them a caret rather than a click.
  if (!props.readonly) view.focus();
});

onBeforeUnmount(() => {
  view?.destroy();
  view = undefined;
});

// Sync external value changes (e.g. reload-from-server) without feedback loops:
// only replace the doc when it actually differs from what CM already holds.
watch(
  () => props.modelValue,
  (next) => {
    if (!view) return;
    if (next !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    }
  },
);

watch([() => props.path, () => props.contentType], () => {
  view?.dispatch({ effects: language.reconfigure(languageExtension()) });
});

watch(
  () => props.readonly,
  (ro) => {
    view?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!ro)) });
  },
);
</script>

<template>
  <div ref="host" class="code-editor h-full overflow-auto text-sm" />
</template>