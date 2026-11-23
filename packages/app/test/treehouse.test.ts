import { describe, expect, it } from "vite-plus/test";
import {
  accessAt,
  accessDraft,
  draftGrants,
  draftIsOpen,
  memberLevel,
  ancestorFolders,
  nearestRestriction,
  buildTree,
  compareNodes,
  findDefaultPage,
  nextListSort,
  parseListSort,
  findNode,
  flattenTree,
  isHiddenPath,
  folderHeading,
  isConflictedCopy,
  resolveDefaultView,
  sortTreeBy,
  withoutHidden,
  viewerKind,
} from "../app/utils/treehouse";

describe("isConflictedCopy", () => {
  it("detects server conflicted-copy names", () => {
    expect(isConflictedCopy("report (conflicted copy — agent — 2026-06-06T00:00Z).md")).toBe(true);
    expect(isConflictedCopy("report.md")).toBe(false);
  });
});

describe("viewerKind", () => {
  it("maps content-types to viewer kinds", () => {
    expect(viewerKind("text/markdown")).toBe("markdown");
    expect(viewerKind("text/html")).toBe("html");
    expect(viewerKind("application/json")).toBe("text");
    expect(viewerKind("text/plain")).toBe("text");
    expect(viewerKind("image/png")).toBe("image");
    expect(viewerKind("image/svg+xml")).toBe("image");
    expect(viewerKind("application/zip")).toBe("binary");
  });

  it("ignores charset params", () => {
    expect(viewerKind("text/markdown; charset=utf-8")).toBe("markdown");
    expect(viewerKind("text/html; charset=utf-8")).toBe("html");
  });

  it("falls back to the path extension for generic/empty content-types", () => {
    expect(viewerKind("application/octet-stream", "notes.md")).toBe("markdown");
    expect(viewerKind("", "page.html")).toBe("html");
    expect(viewerKind("application/octet-stream", "photo.png")).toBe("image");
    expect(viewerKind("application/octet-stream", "mystery")).toBe("binary");
  });
});

describe("findNode", () => {
  it("resolves a folder node and its direct children by path", () => {
    const tree = buildTree([
      { path: "dir/sub/deep.md" },
      { path: "dir/one.md" },
      { path: "top.md" },
    ]);
    const sub = findNode(tree, "dir/sub");
    expect(sub?.isDir).toBe(true);
    expect(sub?.children.map((c) => c.name)).toEqual(["deep.md"]);
    expect(findNode(tree, "top.md")?.isDir).toBe(false);
    expect(findNode(tree, "does/not/exist")).toBeNull();
  });
});

describe("buildTree", () => {
  it("nests directories, sorts dirs first, flags conflicted copies", () => {
    const tree = buildTree([
      { path: "dir/two.md" },
      { path: "dir/one.md" },
      { path: "notes.md" },
      { path: "notes (conflicted copy — agent — x).md" },
    ]);
    expect(tree.map((n) => n.name)).toEqual([
      "dir",
      "notes (conflicted copy — agent — x).md",
      "notes.md",
    ]);
    const dir = tree.find((n) => n.name === "dir");
    expect(dir?.isDir).toBe(true);
    expect(dir?.children.map((c) => c.name)).toEqual(["one.md", "two.md"]);
    expect(tree.find((n) => n.name.includes("conflicted"))?.conflicted).toBe(true);
  });
});
describe("findDefaultPage", () => {
  const tree = (paths: string[]) => buildTree(paths.map((path) => ({ path })));

  it("prefers README.md over index.md over index.html (AE4)", () => {
    expect(findDefaultPage(tree(["readme.md", "index.md", "a.txt"]))?.name).toBe("readme.md");
    expect(findDefaultPage(tree(["index.md", "index.html"]))?.name).toBe("index.md");
    expect(findDefaultPage(tree(["index.html", "notes.md"]))?.name).toBe("index.html");
  });

  it("matches case-insensitively, preferring the canonical spelling", () => {
    expect(findDefaultPage(tree(["Readme.MD"]))?.name).toBe("Readme.MD");
    expect(findDefaultPage(tree(["README.md", "Readme.md"]))?.name).toBe("README.md");
    expect(findDefaultPage(tree(["readme.md", "Readme.md"]))?.name).toBe("readme.md");
  });

  it("returns null when no candidate exists", () => {
    expect(findDefaultPage(tree(["notes.md", "img.png"]))).toBeNull();
    expect(findDefaultPage(tree(["docs/.keep"]))).toBeNull();
    expect(findDefaultPage([])).toBeNull();
  });

  it("ignores folders named like candidates", () => {
    expect(findDefaultPage(tree(["README.md/inner.txt"]))).toBeNull();
  });

  it("finds a root-level default page from the tree's top level", () => {
    const nodes = tree(["README.md", "docs/intro.md"]);
    expect(findDefaultPage(nodes)?.path).toBe("README.md");
  });
});
describe("resolveDefaultView", () => {
  it("returns calendar when view: calendar is declared and children are dated", () => {
    expect(resolveDefaultView({ view: "calendar" }, true)).toBe("calendar");
  });

  it("returns default without dated children even if declared", () => {
    expect(resolveDefaultView({ view: "calendar" }, false)).toBe("default");
  });

  it("returns default when no declaration is present", () => {
    expect(resolveDefaultView({ title: "Posts" }, true)).toBe("default");
    expect(resolveDefaultView(null, true)).toBe("default");
  });
});
describe("folderHeading", () => {
  it("uses the default-page front-matter title when present", () => {
    expect(folderHeading({ title: "Social content" }, "content")).toBe("Social content");
  });

  it("falls back to the folder name when the title is missing, blank, or non-string", () => {
    expect(folderHeading({ view: "calendar" }, "content")).toBe("content");
    expect(folderHeading({ title: "   " }, "content")).toBe("content");
    expect(folderHeading({ title: 42 }, "content")).toBe("content");
    expect(folderHeading(null, "content")).toBe("content");
  });
});
describe("flattenTree", () => {
  it("lists every file and folder, depth first", () => {
    const tree = buildTree(
      [
        { path: "Docs/a.md", contentType: "text/markdown", size: 1, version: 1 },
        { path: "b.md", contentType: "text/markdown", size: 1, version: 1 },
      ] as never,
      {},
      {},
      [],
    );
    expect(flattenTree(tree).map((n) => `${n.isDir ? "d" : "f"}:${n.path}`)).toEqual([
      "d:Docs",
      "f:Docs/a.md",
      "f:b.md",
    ]);
  });
});
describe("listing details", () => {
  const agent = { principal: "agent", actorId: "u1", actorLabel: "Claude Code" };
  const human = { principal: "human", actorId: "u2", actorLabel: null };
  const entries = [
    {
      path: "docs/old.md",
      size: 10,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      modifiedBy: human,
    },
    {
      path: "docs/deep/new.md",
      size: 5,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      modifiedBy: agent,
      unseen: true,
    },
    {
      path: "empty/.keep",
      size: 0,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
      modifiedBy: agent,
      unseen: true,
    },
    {
      path: "a.md",
      size: 1,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
  ];

  it("rolls size, dates, modifier and new-ness up into every containing folder", () => {
    const tree = buildTree(entries);
    const docs = findNode(tree, "docs")!;
    expect(docs).toMatchObject({
      size: 15,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      modifiedBy: agent,
      unseen: true,
    });
    expect(findNode(tree, "docs/deep")?.unseen).toBe(true);
    expect(findNode(tree, "docs/old.md")?.unseen).toBe(false);
  });

  it("dates an empty folder by its .keep but never marks it new", () => {
    const empty = findNode(buildTree(entries), "empty")!;
    expect(empty.createdAt).toBe("2026-02-01T00:00:00.000Z");
    expect(empty.children).toHaveLength(0);
    expect(empty.unseen).toBe(false);
  });

  it("lets the caller override what counts as new", () => {
    const tree = buildTree(entries, {}, {}, [], () => false);
    expect(findNode(tree, "docs")?.unseen).toBe(false);
  });

  it("sorts folders first, then by the chosen column, with missing values last", () => {
    const tree = buildTree([
      ...entries,
      { path: "b.md", size: 9, updatedAt: "2026-05-01T00:00:00.000Z" },
      { path: "c.md" },
    ]);
    const names = (key: Parameters<typeof compareNodes>[2], dir: "asc" | "desc") =>
      [...tree].sort((x, y) => compareNodes(x, y, key, dir)).map((n) => n.name);
    expect(names("name", "desc")).toEqual(["empty", "docs", "c.md", "b.md", "a.md"]);
    expect(names("modified", "desc")).toEqual(["docs", "empty", "b.md", "a.md", "c.md"]);
    expect(names("size", "asc")).toEqual(["empty", "docs", "a.md", "b.md", "c.md"]);
  });

  it("re-sorts every level for the sidebar without touching the built tree", () => {
    const tree = buildTree(entries, {}, { "docs/old.md": 0, "docs/deep": 1 });
    expect(findNode(tree, "docs")!.children.map((n) => n.name)).toEqual(["old.md", "deep"]);
    const byModified = sortTreeBy(tree, "modified");
    expect(byModified.map((n) => n.name)).toEqual(["docs", "empty", "a.md"]);
    expect(findNode(byModified, "docs")!.children.map((n) => n.name)).toEqual(["deep", "old.md"]);
    expect(findNode(tree, "docs")!.children.map((n) => n.name)).toEqual(["old.md", "deep"]);
    expect(sortTreeBy(tree, "custom")).toBe(tree);
  });
});
describe("listing sort preference", () => {
  it("cycles a column: natural direction, flipped, then back to the folder's order", () => {
    let s = nextListSort(null, "modified");
    expect(s).toEqual({ key: "modified", dir: "desc" });
    s = nextListSort(s, "modified");
    expect(s).toEqual({ key: "modified", dir: "asc" });
    expect(nextListSort(s, "modified")).toBeNull();
    expect(nextListSort(s, "name")).toEqual({ key: "name", dir: "asc" });
  });

  it("reads back only a sort it recognises", () => {
    expect(parseListSort('{"key":"size","dir":"desc"}')).toEqual({ key: "size", dir: "desc" });
    expect(parseListSort('{"key":"owner","dir":"asc"}')).toBeNull();
    expect(parseListSort("not json")).toBeNull();
    expect(parseListSort(null)).toBeNull();
  });
});

describe("ancestorFolders", () => {
  it("lists every folder above a file, outermost first", () => {
    expect(ancestorFolders("a/b/c.md")).toEqual(["a", "a/b"]);
  });
  it("has none for a file at the root", () => {
    expect(ancestorFolders("c.md")).toEqual([]);
  });
});

describe("accessAt", () => {
  const restrictions = [
    { path: "clients", kind: "folder", level: "read" },
    { path: "clients/open", kind: "folder", level: "write" },
    { path: "notes.md", kind: "file", level: "read" },
  ];
  const table: [string, string, boolean, string][] = [
    ["an open path", "projects/a.md", false, "write"],
    ["an open path for a viewer", "projects/a.md", true, "read"],
    ["inside a view-only folder", "clients/a.md", false, "read"],
    ["the nearest restriction wins", "clients/open/a.md", false, "write"],
    ["a sibling sharing the prefix", "clients2/a.md", false, "write"],
    ["a file restriction, exact path", "notes.md", false, "read"],
    ["a file restriction doesn't cover what's beside it", "notes.md.bak", false, "write"],
  ];
  it.each(table)("%s", (_name, path, viewOnly, expected) => {
    expect(accessAt(restrictions, path, viewOnly)).toBe(expected);
  });
});

describe("buildTree restricted nodes", () => {
  const entry = (path: string) => ({ path, size: 1, contentType: "text/plain", version: 1 });
  it("doesn't call something shared inside a private folder private", () => {
    const tree = buildTree(
      [entry("personal/project/plan.md"), entry("personal/own.md")],
      {},
      {},
      ["personal"],
      undefined,
      ["personal", "personal/project"],
    );
    const personal = tree.find((n) => n.name === "personal");
    const project = personal?.children.find((n) => n.name === "project");
    expect(personal?.private).toBe(true);
    expect(personal?.children.find((n) => n.name === "own.md")?.private).toBe(true);
    expect(project?.private).toBe(false);
    expect(project?.restricted).toBe(true);
    expect(project?.children[0]?.private).toBe(false);
    expect(project?.children[0]?.restricted).toBe(true);
  });

  it("marks a restricted folder and what's inside it, and no more", () => {
    const tree = buildTree([entry("clients/a.md"), entry("open.md")], {}, {}, [], undefined, [
      "clients",
    ]);
    const clients = tree.find((n) => n.name === "clients");
    expect(clients?.restricted).toBe(true);
    expect(clients?.children[0]?.restricted).toBe(true);
    expect(tree.find((n) => n.name === "open.md")?.restricted).toBeFalsy();
  });
});

describe("accessDraft", () => {
  const clients = {
    path: "clients",
    kind: "folder",
    grants: [
      { subject: "user", userId: "me", level: "read" },
      { subject: "user", userId: "sam", level: "read" },
      { subject: "everyone", userId: null, level: "read" },
    ],
  };
  it("starts from who has what, and always keeps me an editor", () => {
    expect(accessDraft([clients], "clients", "me")).toEqual({
      everyone: "read",
      levels: { me: "write", sam: "read" },
    });
  });
  it("keeps an everyone grant at the level it's at", () => {
    const open = {
      ...clients,
      grants: [{ subject: "everyone", userId: null, level: "write" }],
    };
    expect(accessDraft([open], "clients", "me").everyone).toBe("write");
  });
  it("starts from the folder above, for something inside it", () => {
    expect(accessDraft([clients], "clients/a/b.md", "me").levels.sam).toBe("read");
  });
  it("starts open for something not yet restricted", () => {
    const open = { everyone: "write", levels: { me: "write" } };
    expect(accessDraft([clients], "open/a.md", "me")).toEqual(open);
    expect(accessDraft([], undefined, "me")).toEqual(open);
  });
  it("keeps a restriction with no everyone grant closed to everyone else", () => {
    const closed = { ...clients, grants: [clients.grants[1]!] };
    expect(accessDraft([closed], "clients", "me").everyone).toBe("none");
  });
});

describe("the access dialog", () => {
  const members = [
    { id: "me", role: "owner" },
    { id: "sam", role: "member" },
    { id: "new", role: "member" },
    { id: "out", role: "member" },
  ];
  const levels = { me: "write", sam: "write", out: "none" };

  it("shows someone with no grant of their own what everyone else gets", () => {
    expect(memberLevel(members[2]!, levels, "read")).toBe("read");
    expect(memberLevel(members[2]!, levels, "none")).toBe("none");
  });
  it("keeps an exclusion and a person's own grant over it", () => {
    expect(memberLevel(members[3]!, levels, "read")).toBe("none");
    expect(memberLevel(members[1]!, levels, "read")).toBe("write");
  });
  it("never shows a viewer as an editor", () => {
    expect(memberLevel({ id: "sam", role: "viewer" }, levels, "read")).toBe("read");
  });
  it("changes nothing for someone covered by everyone else, on an unchanged save", () => {
    expect(draftGrants(members, levels, "read")).toEqual([
      { userId: "me", level: "write" },
      { userId: "sam", level: "write" },
      { userId: "out", level: "none" },
    ]);
  });
  it("knows an untouched open draft adds nothing", () => {
    const viewer = { id: "vic", role: "viewer" };
    expect(draftIsOpen([...members, viewer], { me: "write" }, "write")).toBe(true);
  });
  it("knows a draft that narrows anyone is a restriction", () => {
    expect(draftIsOpen(members, { me: "write", sam: "read" }, "write")).toBe(false);
    expect(draftIsOpen(members, { me: "write", out: "none" }, "write")).toBe(false);
    expect(draftIsOpen(members, { me: "write" }, "read")).toBe(false);
  });
  it("only says No access where it means something", () => {
    expect(draftGrants(members, levels, "none")).toEqual([
      { userId: "me", level: "write" },
      { userId: "sam", level: "write" },
    ]);
  });
});

describe("nearestRestriction", () => {
  const rows = [
    { path: "clients", kind: "folder" },
    { path: "clients/open", kind: "folder" },
    { path: "notes.md", kind: "file" },
  ];
  it("finds the one above a nested file, so a dialog starts from real access", () => {
    expect(nearestRestriction(rows, "clients/acme/a.md")?.path).toBe("clients");
    expect(nearestRestriction(rows, "clients/open/a.md")?.path).toBe("clients/open");
  });
  it("finds none for an open path or a sibling sharing a prefix", () => {
    expect(nearestRestriction(rows, "clients2/a.md")).toBeNull();
    expect(nearestRestriction(rows, "notes.md.bak")).toBeNull();
  });
});

describe("withoutHidden", () => {
  const paths = (nodes: ReturnType<typeof buildTree>): string[] =>
    flattenTree(nodes).map((n) => n.path);

  it("drops dot-named files and folders with everything inside them", () => {
    const tree = buildTree(
      [".env", ".claude/settings.json", "docs/.cache/x.md", "docs/a.md", "README.md"].map(
        (path) => ({ path }),
      ),
    );
    expect(paths(withoutHidden(tree))).toEqual(["docs", "docs/a.md", "README.md"]);
  });

  it("treats anything inside a hidden folder as hidden", () => {
    expect(isHiddenPath(".claude/notes.md")).toBe(true);
    expect(isHiddenPath("docs/.cache/x.md")).toBe(true);
    expect(isHiddenPath("docs/a.md")).toBe(false);
  });

  it("hands back the same array when nothing is hidden", () => {
    const tree = buildTree(["docs/a.md", "b.md"].map((path) => ({ path })));
    expect(withoutHidden(tree)).toBe(tree);
  });
});