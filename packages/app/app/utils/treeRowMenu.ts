// What the sidebar tree's row menu offers, as data. The menu component
// (components/TreeRowMenu.vue) only draws it, so the rules about which row gets
// which action live here, where they can be tested.

export type TreeRowAction =
  | "openTab"
  | "openBrowserTab"
  | "copyLink"
  | "newFile"
  | "rename"
  | "move"
  | "editIcon"
  | "restore"
  | "moveUp"
  | "moveDown"
  | "access"
  | "makePrivate"
  | "makeShared"
  | "delete";

/** A menu entry, or (`note`) a line of explanation in place of one. */
export type TreeRowMenuItem =
  | { kind: "action"; action: TreeRowAction; label: string; hint?: string; danger?: boolean }
  | { kind: "note"; text: string };

export interface TreeRowMenuInput {
  node: { isDir: boolean; private?: boolean; explicitPrivate?: boolean; restricted?: boolean };
  /** Whether the member can change this row. Off, only the ways to open it are offered. */
  editable: boolean;
  canOpenTab: boolean;
  canOpenBrowserTab: boolean;
  canCopyLink: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** The ⌘-click hint beside "Open in new tab". */
  tabShortcut: string;
}

const act = (
  action: TreeRowAction,
  label: string,
  extra: { hint?: string; danger?: boolean } = {},
): TreeRowMenuItem => ({ kind: "action", action, label, ...extra });

const when = <T>(cond: boolean, item: T): T[] => (cond ? [item] : []);

function openGroup(o: TreeRowMenuInput): TreeRowMenuItem[] {
  return [
    ...when(o.canOpenTab, act("openTab", "Open in new tab", { hint: o.tabShortcut })),
    ...when(o.canOpenBrowserTab, act("openBrowserTab", "Open in browser tab")),
    ...when(o.canCopyLink, act("copyLink", "Copy link")),
  ];
}

function editGroup(o: TreeRowMenuInput): TreeRowMenuItem[] {
  const dir = o.node.isDir;
  return [
    ...when(dir, act("newFile", "New file here")),
    act("rename", "Rename"),
    act("move", "Move to…"),
    act("editIcon", "Change icon…"),
    ...when(dir, act("restore", "Restore to an earlier time…")),
    ...when(o.canMoveUp, act("moveUp", "Move up")),
    ...when(o.canMoveDown, act("moveDown", "Move down")),
  ];
}

/**
 * Privacy. A node that merely inherits privacy from a folder has no setting of
 * its own to clear, so it gets an explanation rather than a "Make shared" that
 * would silently do nothing.
 */
function accessGroup(o: TreeRowMenuInput): TreeRowMenuItem[] {
  const { node } = o;
  const ownSetting = (!node.private || node.explicitPrivate) && !node.restricted;
  const privacy: TreeRowMenuItem = !ownSetting
    ? {
        kind: "note",
        text: "Private, inherited from a parent folder. Make that folder shared to change this.",
      }
    : node.explicitPrivate
      ? act("makeShared", "Make shared")
      : act("makePrivate", "Make private");
  return [act("access", "Who can access…"), privacy];
}

/** The menu for one row, as groups to draw with a rule between each. Empty groups are dropped. */
export function treeRowMenu(o: TreeRowMenuInput): TreeRowMenuItem[][] {
  const groups = [openGroup(o)];
  if (o.editable) {
    groups.push(editGroup(o), accessGroup(o), [act("delete", "Delete", { danger: true })]);
  }
  return groups.filter((g) => g.length > 0);
}

/**
 * Whether right-clicking a row opens its menu (otherwise the browser's own
 * menu shows). Never on a compact screen, which has its own "⋯", nor on a row
 * being renamed. A row the member can't change still gets one in the
 * workspace's own tree, for the ways to open it; a share's tree has neither.
 */
export function rowMenuOnRightClick(o: {
  compact: boolean;
  renaming: boolean;
  rowReadonly: boolean;
  workspaceTree: boolean;
}): boolean {
  if (o.compact || o.renaming) return false;
  return !o.rowReadonly || o.workspaceTree;
}