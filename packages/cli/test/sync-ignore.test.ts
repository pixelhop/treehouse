import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ignored, preflight } from "../src/sync-core";

// Ignore rules and the pre-flight report (U10). These are the prerequisite for
// the workspace file limit being humane: without them, pointing the CLI at a
// project folder produces a wall of server rejections with no explanation.

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "treehouse-preflight-"));
  roots.push(root);
  return root;
}
function touch(root: string, rel: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "x");
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("ignore rules", () => {
  it("ignores dependency and VCS directories at the root", () => {
    for (const rel of [
      "node_modules/react/index.js",
      ".git/config",
      "__pycache__/mod.pyc",
      "dist/bundle.js",
      "vendor/lib.rb",
      "Pods/Alamofire/README.md",
    ]) {
      expect(ignored(rel)).toBe(true);
    }
  });

  it("ignores them nested at any depth", () => {
    expect(ignored("apps/web/node_modules/react/index.js")).toBe(true);
    expect(ignored("a/b/c/.git/HEAD")).toBe(true);
    expect(ignored("packages/api/dist/index.mjs")).toBe(true);
  });

  it("does not ignore a folder merely named like one", () => {
    // Anchoring on separators is what keeps a real document syncing.
    expect(ignored("my-node_modules-notes/plan.md")).toBe(false);
    expect(ignored("notes/git-workflow.md")).toBe(false);
    expect(ignored("distribution/list.md")).toBe(false);
    expect(ignored("buildings/survey.md")).toBe(false);
  });

  it("still ignores the editor cruft it always did", () => {
    for (const rel of [".treehouse/config.json", "doc.md.swp", "doc.md~", ".DS_Store"]) {
      expect(ignored(rel)).toBe(true);
    }
  });

  it("ignores Obsidian's per-device layout files, wherever the vault sits", () => {
    for (const rel of [
      ".obsidian/workspace.json",
      ".obsidian/workspace-mobile.json",
      "vaults/team/.obsidian/workspace.json",
    ]) {
      expect(ignored(rel)).toBe(true);
    }
  });

  it("still syncs the rest of an Obsidian vault", () => {
    // Settings, themes and plugins are meant to be shared, and a note or a file
    // merely named like the layout file is someone's work.
    for (const rel of [
      ".obsidian/app.json",
      ".obsidian/core-plugins.json",
      ".obsidian/plugins/sample/data.json",
      "workspace.json",
      "projects/workspace.json",
      "my.obsidian/workspace.json",
      ".obsidian/workspace (conflicted copy).json",
      ".obsidian/workspace.json.bak",
    ]) {
      expect(ignored(rel)).toBe(false);
    }
  });

  it("syncs ordinary documents", () => {
    for (const rel of ["notes.md", "Briefs/phoenix.md", "images/logo.png"]) {
      expect(ignored(rel)).toBe(false);
    }
  });
});

describe("preflight", () => {
  it("separates syncable files from ignored ones", () => {
    const root = tempRoot();
    touch(root, "notes.md");
    touch(root, "Briefs/phoenix.md");
    touch(root, "node_modules/react/index.js");
    touch(root, "node_modules/react/package.json");
    touch(root, ".git/HEAD");

    const summary = preflight(root);
    expect(summary.syncable).toBe(2);
    expect(summary.ignored).toBe(3);
  });

  it("names the dominant ignored directories, biggest first", () => {
    // This is the line the user actually reads before their first sync, so the
    // attribution has to be to the directory, not to every leaf file.
    const root = tempRoot();
    touch(root, "readme.md");
    for (let i = 0; i < 12; i++) touch(root, `node_modules/pkg${i}/index.js`);
    for (let i = 0; i < 3; i++) touch(root, `dist/chunk${i}.js`);

    const summary = preflight(root);
    expect(summary.topIgnored[0]).toEqual({ dir: "node_modules", files: 12 });
    expect(summary.topIgnored[1]).toEqual({ dir: "dist", files: 3 });
  });

  it("reports an empty folder without failing", () => {
    const summary = preflight(tempRoot());
    expect(summary).toEqual({ syncable: 0, ignored: 0, topIgnored: [] });
  });

  it("reports nothing ignored for a clean documents folder", () => {
    const root = tempRoot();
    touch(root, "a.md");
    touch(root, "sub/b.md");
    const summary = preflight(root);
    expect(summary.syncable).toBe(2);
    expect(summary.ignored).toBe(0);
    expect(summary.topIgnored).toEqual([]);
  });
});