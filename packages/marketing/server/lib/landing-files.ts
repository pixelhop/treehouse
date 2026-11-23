/**
 * Build-time view of comparison pages and guides (`content/pages/**`), for the
 * same reason as docs-files.ts: the prerender list must be known when
 * nuxt.config is evaluated, before the content database exists. The tests use
 * this reader too, so what they check is what gets built.
 *
 * Node-only, like docs-files.ts.
 */
import { fileURLToPath } from "node:url";
import { readDocsFiles, type DocsFile } from "./docs-files";

const LANDING_CONTENT_DIR = fileURLToPath(new URL("../../content/pages", import.meta.url));

export interface LandingFile extends DocsFile {
  /** Served URL path (`/compare/obsidian`). */
  path: string;
}

export function readLandingFiles(): LandingFile[] {
  return readDocsFiles(LANDING_CONTENT_DIR).map((file) => ({
    ...file,
    path: `/${file.relativePath.replace(/\.md$/, "")}`,
  }));
}

/** Every landing URL to prerender. The hub is a Vue page, so it's added here. */
export function landingPrerenderRoutes(files: LandingFile[] = readLandingFiles()): string[] {
  return ["/compare", ...files.map((file) => file.path)];
}