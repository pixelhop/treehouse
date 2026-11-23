/**
 * Contract checks for the public docs (content/docs/**), per
 * .agent/docs/public-docs.md. They read the markdown straight from disk with
 * the same reader nuxt.config uses, so what they validate is what gets built.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FILE_TYPES } from "shared";
import { describe, expect, it } from "vite-plus/test";
import {
  DOCS_PAGE_TYPES,
  DOCS_PLANS,
  DOCS_RELEASES,
  docsParentPath,
} from "../../app/utils/docs-tree";
import { docsFileMeta, docsPages, readDocsFiles } from "../../server/lib/docs-files";

const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));
const files = docsPages(readDocsFiles());
const pagePaths = new Set(files.map((file) => file.path));

/** The body with fenced code blocks and inline code removed: the prose. */
function prose(body: string): string {
  return body.replace(/^(`{3,})[\s\S]*?^\1\s*$/gm, "").replace(/`[^`\n]*`/g, "");
}

/** Heading anchors as @nuxt/content generates them. */
function slug(heading: string): string {
  return (
    heading
      .replace(/`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Emphasis markers go; an underscore inside a word (`get_links`) stays,
      // as it does in the ids the site renders.
      .replace(/\*/g, "")
      .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-")
  );
}

function anchors(body: string): Set<string> {
  const ids = new Set<string>();
  for (const match of prose(body).matchAll(/^#{2,4}\s+(.+?)\s*$/gm)) ids.add(slug(match[1] ?? ""));
  return ids;
}

/** Every markdown link target and MDC `href` in a page. */
function links(body: string): string[] {
  const text = prose(body);
  return [
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ""),
    ...[...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? ""),
  ];
}

describe("docs content", () => {
  it("has pages", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  describe.each(files.map((file) => [file.relativePath, file] as const))("%s", (_name, file) => {
    const meta = docsFileMeta(file);

    it("has valid frontmatter", () => {
      expect(meta.title, "title").toBeTruthy();
      expect(DOCS_PAGE_TYPES).toContain(meta.type);
      expect(typeof meta.position, "position").toBe("number");
      expect(meta.updated, "updated").toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const description = meta.description ?? "";
      expect(description.length, `description length: "${description}"`).toBeGreaterThanOrEqual(50);
      expect(description.length, `description length: "${description}"`).toBeLessThanOrEqual(160);
      if (meta.release) expect(DOCS_RELEASES).toContain(meta.release);
      for (const plan of meta.plans ?? []) expect(DOCS_PLANS).toContain(plan);
    });

    it("folder index pages are hubs", () => {
      if (file.relativePath.endsWith("index.md")) expect(meta.type).toBe("hub");
    });

    it("never writes an H1 in the body", () => {
      expect(prose(file.body)).not.toMatch(/^#\s/m);
    });

    it("uses no em dashes in prose", () => {
      const lines = prose(file.body)
        .split("\n")
        .filter((line) => line.includes("—"));
      expect(lines).toEqual([]);
    });

    it("avoids words the voice guide rules out", () => {
      const banned =
        /\b(supercharge[sd]?|revolutioni[sz]e[sd]?|empower(s|ed|ing)?|leverag(e|es|ed|ing)|seamless(ly)?|game-changing|cutting-edge)\b/i;
      expect(prose(file.body).match(banned)?.[0] ?? null).toBeNull();
    });

    it("links only to docs pages and anchors that exist", () => {
      const broken: string[] = [];
      for (const href of links(file.body)) {
        if (!href.startsWith("/docs") || href.startsWith("/docs/images/")) continue;
        const [rawPath = "", anchor] = href.split("#");
        const path = rawPath.replace(/\.md$/, "").replace(/\/$/, "");
        if (!pagePaths.has(path)) {
          broken.push(href);
          continue;
        }
        if (anchor) {
          const target = files.find((other) => other.path === path);
          if (target && !anchors(target.body).has(anchor)) broken.push(href);
        }
      }
      expect(broken).toEqual([]);
    });

    it("only uses images that exist", () => {
      const missing = links(file.body)
        .filter((href) => href.startsWith("/docs/images/"))
        .filter((href) => !existsSync(`${PUBLIC_DIR}${href}`));
      expect(missing).toEqual([]);
    });

    it("lists related pages that exist", () => {
      const missing = (meta.related ?? []).filter((path) => !pagePaths.has(path));
      expect(missing).toEqual([]);
    });
  });

  it("gives every page a hub", () => {
    const orphans = files
      .map((file) => file.path)
      .filter((path) => path !== "/docs")
      .filter((path) => !pagePaths.has(docsParentPath(path) ?? ""));
    expect(orphans).toEqual([]);
  });

  it("keeps sidebar positions unique within each folder", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const file of files) {
      if (file.path === "/docs") continue;
      const key = `${docsParentPath(file.path)}#${docsFileMeta(file).position}`;
      const other = seen.get(key);
      if (other) clashes.push(`${other} and ${file.path}`);
      seen.set(key, file.path);
    }
    expect(clashes).toEqual([]);
  });

  it("documents every content type the file-type table assigns", () => {
    // The REST reference lists what a write without a Content-Type is stored as.
    // It is copied from FILE_TYPES (packages/shared/fileTypes.ts) by hand, so
    // check the copy rather than trusting it.
    const page = files.find((file) => file.path === "/docs/agents/reference/rest-api");
    const documented = new Map<string, string>();
    for (const [, exts = "", type = ""] of (page?.body ?? "").matchAll(
      /^\|\s*(`\.[^|]+?)\s*\|\s*`([^`]+)`\s*\|$/gm,
    )) {
      for (const [, ext] of exts.matchAll(/`\.([a-z0-9]+)`/g)) documented.set(ext ?? "", type);
    }
    const expected = new Map(Object.entries(FILE_TYPES).map(([ext, t]) => [ext, t.contentType]));
    expect(documented).toEqual(expected);
  });
});