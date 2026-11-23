// App-specific tree builder for the read-only workspace view. Content-type and
// conflicted-copy helpers come from the shared package (one source of truth).
import { isConflictedCopy, isKeepFile } from "shared";
import type { FileModifier } from "../composables/useTreehouseApi";
import type { FrontMatterData } from "./frontmatterData";

export { baseContentType, isConflictedCopy, viewerKind, type ViewerKind } from "shared";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  conflicted: boolean;
  /** Custom emoji/Iconify icon for this node, if set (else a default is used). */
  icon: string | null;
  /** Custom sibling order (lower first); null = use the default sort. */
  order: number | null;
  /** Private to the current viewer (this node or a private ancestor folder). */
  private: boolean;
  /** Shared with specific people (this node or an ancestor folder), not private to the viewer. */
  restricted?: boolean;
  /** This node carries its OWN explicit private ACL (vs. inheriting from an
   * ancestor). Only an explicitly-private node can be unmarked here — clearing a
   * node that merely inherits privacy does nothing. */
  explicitPrivate: boolean;
  // Listing details, when the listing carries them (null otherwise — a public
  // share's doesn't). A folder rolls its contents up: total size, earliest
  // created, latest modified and who made that change, and whether anything
  // inside is new to you.
  size: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  modifiedBy: FileModifier | null;
  /** Changed recently by someone else and not yet opened (a folder: something inside is). */
  unseen: boolean;
  children: TreeNode[];
}

/** The entry fields buildTree reads; everything past `path` is optional. */
export interface TreeEntry {
  path: string;
  size?: number;
  createdAt?: string;
  updatedAt?: string;
  modifiedBy?: FileModifier | null;
  unseen?: boolean;
}

// ISO timestamps compare as strings. An absent one never wins.
const isBefore = (a: string | undefined, b: string | null) => !!a && (!b || a < b);
const isAfter = (a: string | undefined, b: string | null) => !!a && (!b || a > b);

// Roll one file's details up into a folder that contains it.
function foldInto(folder: TreeNode, e: TreeEntry, unseen: boolean): void {
  if (e.size !== undefined) folder.size = (folder.size ?? 0) + e.size;
  if (isBefore(e.createdAt, folder.createdAt)) folder.createdAt = e.createdAt!;
  if (isAfter(e.updatedAt, folder.updatedAt)) {
    folder.updatedAt = e.updatedAt!;
    folder.modifiedBy = e.modifiedBy ?? null;
  }
  folder.unseen ||= unseen;
}

/** A file node carrying its listing details; a folder starts empty and rolls up. */
function nodeDetails(
  e: TreeEntry | null,
  unseen: boolean,
): Pick<TreeNode, "size" | "createdAt" | "updatedAt" | "modifiedBy" | "unseen"> {
  return {
    size: e?.size ?? null,
    createdAt: e?.createdAt ?? null,
    updatedAt: e?.updatedAt ?? null,
    modifiedBy: e?.modifiedBy ?? null,
    unseen,
  };
}

/**
 * Build a directory/file tree from a flat path list for rendering. `icons` and
 * `orders` are optional path→value maps (covering files and synthesized folders).
 * `privatePaths` are the viewer's own private node paths; a node is flagged
 * private when its path, or any ancestor folder, is private (inheritance).
 * `isUnseen` decides the "new to you" marker per file; it defaults to the
 * listing's own flag, and the workspace overrides it to drop files opened since.
 */
export function buildTree(
  entries: TreeEntry[],
  icons: Record<string, string> = {},
  orders: Record<string, number> = {},
  privatePaths: string[] = [],
  isUnseen: (entry: TreeEntry) => boolean = (e) => !!e.unseen,
  restrictedPaths: string[] = [],
): TreeNode[] {
  const privateSet = new Set(privatePaths);
  const restrictedSet = new Set(restrictedPaths);
  // Inherit from a private ancestor, else this node's own ACL. A restriction of its
  // own replaces the ancestor's, so one shared inside a private folder isn't private.
  const privacy = (parent: TreeNode, path: string) => ({
    private: privateSet.has(path) || (parent.private && !restrictedSet.has(path)),
    explicitPrivate: privateSet.has(path),
    restricted: restrictedSet.has(path) || (parent.restricted && !privateSet.has(path)),
  });
  const root: TreeNode = {
    name: "",
    path: "",
    isDir: true,
    conflicted: false,
    icon: null,
    order: null,
    private: false,
    explicitPrivate: false,
    ...nodeDetails(null, false),
    children: [],
  };
  for (const entry of entries) {
    const { path } = entry;
    const parts = path.split("/");
    const keep = isKeepFile(path);
    // A `.keep` still dates its folder (it is written when the folder is made),
    // but it can never be opened, so it must not leave a marker nothing clears.
    const unseen = !keep && isUnseen(entry);
    let node = root;
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      // A `.keep` placeholder materializes its folder but is never shown — skip
      // the leaf so the (now non-empty) folder still renders as empty.
      if (isLeaf && keep) return;
      const childPath = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part && c.isDir !== isLeaf);
      if (!child) {
        child = {
          name: part,
          path: childPath,
          isDir: !isLeaf,
          conflicted: isLeaf && isConflictedCopy(part),
          icon: icons[childPath] ?? null,
          order: orders[childPath] ?? null,
          ...privacy(node, childPath),
          ...(isLeaf ? nodeDetails(entry, unseen) : nodeDetails(null, false)),
          children: [],
        };
        node.children.push(child);
      }
      if (child.isDir) foldInto(child, entry, unseen);
      node = child;
    });
  }
  sortTree(root);
  return root.children;
}

// A folder's default page (README.md > index.md > index.html, case-insensitive)
// fronts the folder in the UI, with the listing one toggle away.
const DEFAULT_PAGE_NAMES = ["README.md", "index.md", "index.html"];

/**
 * The file a folder presents as its default page, or null. When several case
 * variants of one candidate exist, the canonical spelling wins, then the
 * lexicographically-first — deterministic regardless of listing order.
 */
export function findDefaultPage(children: TreeNode[]): TreeNode | null {
  for (const canonical of DEFAULT_PAGE_NAMES) {
    const lower = canonical.toLowerCase();
    const matches = children.filter((c) => !c.isDir && c.name.toLowerCase() === lower);
    if (matches.length === 0) continue;
    const exact = matches.find((c) => c.name === canonical);
    return exact ?? [...matches].sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
  }
  return null;
}

/**
 * Which view a folder should open in. A folder pins the calendar as its default
 * with a `view: calendar` key in its default-page (README/index) front matter,
 * but only when it actually has dated children — otherwise there is no calendar
 * to show and it falls back to the normal default-page/listing behavior.
 * `view: board` pins the board, which opens even when it has no cards yet. Pure:
 * the front matter is read by the folder front-matter loader, not here.
 */
export function resolveDefaultView(
  defaultPageFrontMatter: FrontMatterData | null,
  hasDatedChildren: boolean,
): "calendar" | "board" | "default" {
  if (hasDatedChildren && defaultPageFrontMatter?.view === "calendar") return "calendar";
  // A declared board opens even with no cards (see `boardAvailable`).
  if (defaultPageFrontMatter?.view === "board") return "board";
  return "default";
}

/**
 * Whether a folder offers the Board view: any child carries a `status`, or its
 * default page declares `view: board`. Unlike the calendar, a declared board is
 * offered even with no cards — a freshly created board would otherwise be
 * invisible until someone hand-wrote a status.
 */
export function boardAvailable(
  defaultPageFrontMatter: FrontMatterData | null,
  hasStatusChildren: boolean,
): boolean {
  return hasStatusChildren || defaultPageFrontMatter?.view === "board";
}

/**
 * A folder's human-readable heading: the `title` from its default-page
 * (README/index) front matter when set, else the folder name. Lets a README give
 * a folder a nicer display name (e.g. "Social content" over the raw `content`
 * folder) without a separate folder-title field — the title lives in a plain,
 * agent-writable file, like the `view: calendar` declaration.
 */
export function folderHeading(
  defaultPageFrontMatter: FrontMatterData | null,
  fallback: string,
): string {
  const title = defaultPageFrontMatter?.title;
  return typeof title === "string" && title.trim() ? title : fallback;
}

/** Find a node anywhere in the tree by its full path (used to resolve a folder selection). */
export function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.isDir && path.startsWith(`${node.path}/`)) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

/** Every node in the tree, files and folders, as the flat list file search scores. */
export function flattenTree(
  nodes: TreeNode[],
  acc: { path: string; name: string; isDir: boolean }[] = [],
): { path: string; name: string; isDir: boolean }[] {
  for (const n of nodes) {
    acc.push({ path: n.path, name: n.name, isDir: n.isDir });
    if (n.isDir) flattenTree(n.children, acc);
  }
  return acc;
}

/** The restriction that applies to `path`: the nearest one covering it, as the server decides. */
export function nearestRestriction<T extends { path: string; kind: string }>(
  restrictions: T[],
  path: string,
): T | null {
  let nearest: T | null = null;
  for (const r of restrictions) {
    const covers = r.path === path || (r.kind === "folder" && path.startsWith(`${r.path}/`));
    if (covers && (!nearest || r.path.length > nearest.path.length)) nearest = r;
  }
  return nearest;
}

/**
 * How far this member reaches `path`: the restriction that applies, which the
 * server has already capped by their role and key, else the workspace's default
 * for them.
 */
export function accessAt(
  restrictions: { path: string; kind: string; level: string }[],
  path: string,
  viewOnly: boolean,
): string {
  return nearestRestriction(restrictions, path)?.level ?? (viewOnly ? "read" : "write");
}

/**
 * The access dialog's starting point: who reaches `path` now, through whichever
 * restriction applies, with `me` always an editor, since saving without that is
 * refused. With no restriction it is open, so everyone starts as an editor and
 * restricting it is something you choose here, not where you begin.
 */
export function accessDraft(
  restrictions: {
    path: string;
    kind: string;
    grants: { subject: string; userId: string | null; level: string }[];
  }[],
  path: string | undefined,
  me: string | null,
): { everyone: string; levels: Record<string, string> } {
  const restriction = path ? nearestRestriction(restrictions, path) : null;
  const grants = restriction?.grants ?? [];
  const open = grants.find((g) => g.subject === "everyone");
  const levels: Record<string, string> = {};
  for (const g of grants) if (g.userId) levels[g.userId] = g.level;
  if (me) levels[me] = "write";
  return { everyone: restriction ? (open?.level ?? "none") : "write", levels };
}

/**
 * Does the draft leave everyone as far as their role reaches: everyone else an
 * editor and nobody narrowed? On an item nothing restricts, saving that would
 * add a restriction that changes nothing, so the dialog saves nothing.
 */
export function draftIsOpen(
  members: { id: string; role: string }[],
  levels: Record<string, string>,
  everyone: string,
): boolean {
  return (
    everyone === "write" &&
    members.every(
      (m) => memberLevel(m, levels, everyone) === (m.role === "viewer" ? "read" : "write"),
    )
  );
}

/**
 * The level the dialog shows for one person. Someone with no grant of their own
 * is covered by "Everyone else", so they follow it. A viewer never edits.
 */
export function memberLevel(
  member: { id: string; role: string },
  levels: Record<string, string>,
  everyone: string,
): string {
  const level = levels[member.id] ?? everyone;
  return member.role === "viewer" && level === "write" ? "read" : level;
}

/**
 * What the dialog saves: the people with a grant of their own. Anyone else stays
 * covered by "Everyone else". "No access" only needs saying when everyone else can
 * read: there it's an exclusion, and dropping it would let them in.
 */
export function draftGrants(
  members: { id: string; role: string }[],
  levels: Record<string, string>,
  everyone: string,
): { userId: string; level: string }[] {
  return members
    .filter((m) => levels[m.id] !== undefined)
    .map((m) => ({ userId: m.id, level: memberLevel(m, levels, everyone) }))
    .filter((g) => g.level !== "none" || everyone !== "none");
}

/** Every folder above a file: `a/b/c.md` is in `a` and `a/b`. */
export function ancestorFolders(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** All folder paths in the tree (for expand-all). */
export function collectFolderPaths(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.isDir) {
      acc.push(node.path);
      collectFolderPaths(node.children, acc);
    }
  }
  return acc;
}

// Ordered siblings sort by their explicit order; unordered siblings fall back to
// folders-first then alphabetical, and sort after any explicitly-ordered ones.
function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name);
  });
  for (const c of node.children) sortTree(c);
}
// --- Sorting a listing by name, date or size ---------------------------------

/** How the sidebar tree orders siblings. "custom" is the shared drag order. */
export type TreeSort = "custom" | "name" | "modified";
export const TREE_SORT_LABELS: Record<TreeSort, string> = {
  custom: "Custom order",
  name: "Name",
  modified: "Recently modified",
};
export const TREE_SORTS = Object.keys(TREE_SORT_LABELS) as TreeSort[];

// --- Persisted listing sorts (the logic behind useSortPrefs) ------------------

/** A folder listing's sort; null keeps the folder's own order (custom, then A–Z). */
export type ListSort = { key: ListSortKey; dir: SortDir } | null;

// Which way a column runs on its first click: names A–Z, newest and largest first.
const FIRST_DIR: Record<ListSortKey, SortDir> = {
  name: "asc",
  modified: "desc",
  created: "desc",
  size: "desc",
};

/** A stored listing sort, or null for anything unreadable. */
export function parseListSort(raw: string | null): ListSort {
  try {
    const v = JSON.parse(raw ?? "null") as { key?: ListSortKey; dir?: unknown } | null;
    if (!v?.key || !(v.key in FIRST_DIR)) return null;
    return { key: v.key, dir: v.dir === "desc" ? "desc" : "asc" };
  } catch {
    return null;
  }
}

/**
 * The sort after a column header click: a new column starts in its natural
 * direction, the same column flips, and a third click goes back to the
 * folder's own order.
 */
export function nextListSort(cur: ListSort, key: ListSortKey): ListSort {
  if (cur?.key !== key) return { key, dir: FIRST_DIR[key] };
  if (cur.dir !== FIRST_DIR[key]) return null;
  return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
}

/** A sortable column of the folder listing. */
export type ListSortKey = "name" | "modified" | "created" | "size";
export type SortDir = "asc" | "desc";

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Compare two siblings by one column. Folders always come before files, like
 * every file browser; ties and missing values fall back to the name, and a
 * missing value sorts last whichever way the column runs.
 */
export function compareNodes(a: TreeNode, b: TreeNode, key: ListSortKey, dir: SortDir): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const byName = nameCollator.compare(a.name, b.name);
  const sign = dir === "asc" ? 1 : -1;
  if (key === "name") return sign * byName;
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  // Missing values go last in both directions, so they don't take the sign.
  if (va === null || vb === null) return Number(va === null) - Number(vb === null) || byName;
  return sign * (va < vb ? -1 : va > vb ? 1 : 0) || byName;
}

const SORT_FIELD = { modified: "updatedAt", created: "createdAt", size: "size" } as const;

function sortValue(n: TreeNode, key: Exclude<ListSortKey, "name">): string | number | null {
  return n[SORT_FIELD[key]];
}

/** A dot-named file or folder (`.claude`, `.env`), hidden by default the way Finder hides it. */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/** A path that is hidden itself or sits inside a hidden folder (`.claude/notes.md`). */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some(isHiddenName);
}

/**
 * The tree without its hidden nodes. A hidden folder goes with everything in
 * it, so `.git/config` disappears with `.git`. Returns the same array when
 * nothing at a level is hidden, so the common case allocates almost nothing.
 */
export function withoutHidden(nodes: TreeNode[]): TreeNode[] {
  let changed = false;
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (isHiddenName(n.name)) {
      changed = true;
      continue;
    }
    if (n.isDir) {
      const children = withoutHidden(n.children);
      if (children !== n.children) {
        changed = true;
        out.push({ ...n, children });
        continue;
      }
    }
    out.push(n);
  }
  return changed ? out : nodes;
}

/** The nodes as a listing shows them: everything, or without the hidden ones. */
export function visibleNodes(nodes: TreeNode[], showHidden: boolean): TreeNode[] {
  return showHidden ? nodes : withoutHidden(nodes);
}

/**
 * The tree re-sorted at every level for the sidebar's sort setting. "custom"
 * is the tree as built (explicit order, then folders-first A–Z). Returns new
 * folder nodes rather than sorting in place: the built tree is shared.
 */
export function sortTreeBy(nodes: TreeNode[], mode: TreeSort): TreeNode[] {
  if (mode === "custom") return nodes;
  const key: ListSortKey = mode === "name" ? "name" : "modified";
  const dir: SortDir = mode === "name" ? "asc" : "desc";
  return [...nodes]
    .sort((a, b) => compareNodes(a, b, key, dir))
    .map((n) => (n.isDir ? { ...n, children: sortTreeBy(n.children, mode) } : n));
}