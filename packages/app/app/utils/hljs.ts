// A highlight.js core instance with only the languages the code-language table
// (utils/codeLanguage.ts) uses. Registering here (module scope) runs once per
// app session instead of on every CodeViewer mount.
//
// `HLJS_LANGUAGES` is keyed by exactly the table's highlight.js ids: a language
// the table names but this file doesn't import, or one imported but no longer
// used, fails the typecheck. Import grammars one by one from
// `highlight.js/lib/languages/*`, never the full `highlight.js` bundle.
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { HljsLanguage } from "./codeLanguage";

const HLJS_LANGUAGES: Record<HljsLanguage, LanguageFn> = {
  bash,
  css,
  ini,
  javascript,
  json,
  python,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [id, language] of Object.entries(HLJS_LANGUAGES)) {
  hljs.registerLanguage(id, language);
}

export default hljs;