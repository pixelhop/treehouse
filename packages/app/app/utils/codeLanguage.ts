// Which language a code file is highlighted as, in the viewer (highlight.js)
// and in the editor (CodeMirror). One entry per extension, keyed by the shared
// file-type table's `FileExtension`, so an extension here is always one the
// CLI and API store as text.
//
// Both libraries load their grammars from typed tables keyed by the ids used
// here: `HLJS_LANGUAGES` in utils/hljs.ts and `CM_LANGUAGES` in
// components/editors/CodeEditor.vue. A new id without a grammar there fails the
// typecheck, rather than silently rendering as plain text.
//
// This module imports neither library, so it stays cheap to test and doesn't
// pull a grammar into whatever chunk imports it.
import { extensionForContentType, knownExtension, type FileExtension } from "shared";

interface CodeLanguage {
  /** highlight.js language, for CodeViewer. Omit to show the file unhighlighted. */
  hljs?: string;
  /** CodeMirror language, for CodeEditor. Omit to edit the file as plain text. */
  cm?: string;
}

export const CODE_LANGUAGES = {
  json: { hljs: "json", cm: "json" },
  js: { hljs: "javascript", cm: "javascript" },
  mjs: { hljs: "javascript", cm: "javascript" },
  cjs: { hljs: "javascript", cm: "javascript" },
  jsx: { hljs: "javascript", cm: "jsx" },
  ts: { hljs: "typescript", cm: "typescript" },
  mts: { hljs: "typescript", cm: "typescript" },
  cts: { hljs: "typescript", cm: "typescript" },
  tsx: { hljs: "typescript", cm: "tsx" },
  html: { hljs: "xml", cm: "html" },
  htm: { hljs: "xml", cm: "html" },
  // An SFC is HTML with <script> and <style> blocks, which the HTML grammar nests.
  vue: { hljs: "xml", cm: "html" },
  xml: { hljs: "xml" },
  svg: { hljs: "xml" },
  css: { hljs: "css", cm: "css" },
  yaml: { hljs: "yaml", cm: "yaml" },
  yml: { hljs: "yaml", cm: "yaml" },
  // highlight.js highlights TOML with its INI grammar.
  toml: { hljs: "ini" },
  sh: { hljs: "bash" },
  bash: { hljs: "bash" },
  zsh: { hljs: "bash" },
  py: { hljs: "python" },
  sql: { hljs: "sql" },
  // The markdown viewer renders markdown itself; only the editor's source mode
  // needs a grammar.
  md: { cm: "markdown" },
  markdown: { cm: "markdown" },
} as const satisfies Partial<Record<FileExtension, CodeLanguage>>;

type Entry = (typeof CODE_LANGUAGES)[keyof typeof CODE_LANGUAGES];

/** Every highlight.js language the table uses. utils/hljs.ts must register each one. */
export type HljsLanguage = Extract<Entry, { hljs: string }>["hljs"];

/** Every CodeMirror language the table uses. CodeEditor.vue must load each one. */
export type CmLanguageId = Extract<Entry, { cm: string }>["cm"];

// The extension decides when it is in the table (it tells .tsx from .ts, which
// share a content type). Otherwise the content type's usual extension does, for
// a file with no extension or one we don't know.
function languageFor(path: string, contentType: string): Entry | undefined {
  const table: Partial<Record<FileExtension, Entry>> = CODE_LANGUAGES;
  const ext = knownExtension(path);
  if (ext && table[ext]) return table[ext];
  const fromType = extensionForContentType(contentType);
  return fromType ? table[fromType] : undefined;
}

/** The highlight.js language for a file, or null to show it as plain text. */
export function codeLanguage(path: string, contentType = ""): HljsLanguage | null {
  const lang = languageFor(path, contentType);
  return lang && "hljs" in lang ? lang.hljs : null;
}

/** The CodeMirror language for a file, or null to edit it as plain text. */
export function cmLanguageId(path: string, contentType = ""): CmLanguageId | null {
  const lang = languageFor(path, contentType);
  return lang && "cm" in lang ? lang.cm : null;
}