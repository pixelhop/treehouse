import { FILE_TYPES, viewerKind } from "shared";
import { describe, expect, it } from "vite-plus/test";
import { CODE_LANGUAGES, cmLanguageId, codeLanguage } from "../app/utils/codeLanguage";
import hljs from "../app/utils/hljs";

const extensions = Object.keys(CODE_LANGUAGES) as Array<keyof typeof CODE_LANGUAGES>;

describe("codeLanguage", () => {
  it("picks a highlight.js language from the extension", () => {
    expect(codeLanguage("data.json")).toBe("json");
    expect(codeLanguage("app.ts")).toBe("typescript");
    expect(codeLanguage("App.tsx")).toBe("typescript");
    expect(codeLanguage("main.js")).toBe("javascript");
    expect(codeLanguage("styles.css")).toBe("css");
    expect(codeLanguage("deploy.sh")).toBe("bash");
    expect(codeLanguage("config.yaml")).toBe("yaml");
    expect(codeLanguage("App.vue")).toBe("xml");
    expect(codeLanguage("page.html")).toBe("xml");
    expect(codeLanguage("pyproject.toml")).toBe("ini");
  });

  it("falls back to the content-type for an unknown or missing extension", () => {
    expect(codeLanguage("mystery", "application/json")).toBe("json");
    expect(codeLanguage("x", "text/css; charset=utf-8")).toBe("css");
    expect(codeLanguage("Dockerfile", "application/yaml")).toBe("yaml");
  });

  it("lets the extension win over a misleading browser content-type", () => {
    // Chrome reports .ts files as MPEG transport streams.
    expect(codeLanguage("app.ts", "video/mp2t")).toBe("typescript");
  });

  it("returns null for unknown or plain types (renders as plaintext)", () => {
    expect(codeLanguage("notes.txt")).toBeNull();
    expect(codeLanguage("data.csv")).toBeNull();
    expect(codeLanguage("notes.md")).toBeNull();
    expect(codeLanguage("weird.xyz")).toBeNull();
    expect(codeLanguage("noextension")).toBeNull();
  });
});

describe("cmLanguageId", () => {
  it("picks a CodeMirror language from the extension", () => {
    expect(cmLanguageId("data.json")).toBe("json");
    expect(cmLanguageId("app.ts")).toBe("typescript");
    expect(cmLanguageId("App.tsx")).toBe("tsx");
    expect(cmLanguageId("main.js")).toBe("javascript");
    expect(cmLanguageId("App.jsx")).toBe("jsx");
    expect(cmLanguageId("config.yaml")).toBe("yaml");
    expect(cmLanguageId("config.yml")).toBe("yaml");
    expect(cmLanguageId("notes.md")).toBe("markdown");
    expect(cmLanguageId("page.html")).toBe("html");
    expect(cmLanguageId("styles.css")).toBe("css");
  });

  it("falls back to the content-type for an unknown or missing extension", () => {
    expect(cmLanguageId("mystery", "application/json")).toBe("json");
    expect(cmLanguageId("x", "text/markdown; charset=utf-8")).toBe("markdown");
    expect(cmLanguageId("y", "text/typescript")).toBe("typescript");
    expect(cmLanguageId("z", "text/html")).toBe("html");
  });

  it("returns null when there's no grammar (edits as plaintext)", () => {
    expect(cmLanguageId("notes.txt")).toBeNull();
    expect(cmLanguageId("data.csv")).toBeNull();
    expect(cmLanguageId("deploy.sh")).toBeNull();
    expect(cmLanguageId("weird.xyz")).toBeNull();
    expect(cmLanguageId("noextension")).toBeNull();
  });
});

describe("CODE_LANGUAGES", () => {
  it("only lists extensions the file-type table stores as text", () => {
    for (const ext of extensions) {
      expect(FILE_TYPES[ext].text, ext).toBe(true);
    }
  });

  it("names only highlight.js languages that utils/hljs registers", () => {
    for (const ext of extensions) {
      const lang = codeLanguage(`file.${ext}`);
      if (lang) expect(hljs.getLanguage(lang), `${ext} → ${lang}`).toBeDefined();
    }
  });

  it("gives every code file a viewer that shows its text", () => {
    // A code language is pointless if the viewer treats the file as a download.
    for (const ext of extensions) {
      expect(viewerKind("", `file.${ext}`), ext).not.toBe("binary");
    }
  });
});