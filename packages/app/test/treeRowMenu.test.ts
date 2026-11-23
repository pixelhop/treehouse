import { describe, expect, it } from "vite-plus/test";
import {
  rowMenuOnRightClick,
  treeRowMenu,
  type TreeRowMenuInput,
  type TreeRowMenuItem,
} from "../app/utils/treeRowMenu";

const base: TreeRowMenuInput = {
  node: { isDir: false },
  editable: true,
  canOpenTab: true,
  canOpenBrowserTab: true,
  canCopyLink: true,
  canMoveUp: false,
  canMoveDown: false,
  tabShortcut: "⌘-click",
};

const actions = (groups: TreeRowMenuItem[][]) =>
  groups.map((g) => g.map((i) => (i.kind === "action" ? i.action : "note")));

describe("treeRowMenu", () => {
  it("gives a file the open, edit, access and delete groups", () => {
    expect(actions(treeRowMenu(base))).toEqual([
      ["openTab", "openBrowserTab", "copyLink"],
      ["rename", "move", "editIcon"],
      ["access", "makePrivate"],
      ["delete"],
    ]);
  });

  it("adds new-file and restore for a folder, and reorder only when offered", () => {
    const groups = treeRowMenu({ ...base, node: { isDir: true }, canMoveUp: true });
    expect(actions(groups)[1]).toEqual([
      "newFile",
      "rename",
      "move",
      "editIcon",
      "restore",
      "moveUp",
    ]);
  });

  it("offers only the ways to open a row the member can't change", () => {
    expect(actions(treeRowMenu({ ...base, editable: false }))).toEqual([
      ["openTab", "openBrowserTab", "copyLink"],
    ]);
  });

  it("drops the open group when there's nothing to open into", () => {
    const groups = treeRowMenu({
      ...base,
      canOpenTab: false,
      canOpenBrowserTab: false,
      canCopyLink: false,
    });
    expect(actions(groups)[0]).toEqual(["rename", "move", "editIcon"]);
  });

  it("offers Make shared on a node made private itself", () => {
    const groups = treeRowMenu({
      ...base,
      node: { isDir: false, private: true, explicitPrivate: true },
    });
    expect(actions(groups)[2]).toEqual(["access", "makeShared"]);
  });

  it("explains inherited privacy instead of offering a toggle that does nothing", () => {
    const groups = treeRowMenu({ ...base, node: { isDir: false, private: true } });
    expect(actions(groups)[2]).toEqual(["access", "note"]);
  });

  it("explains rather than toggles on a restricted node", () => {
    const groups = treeRowMenu({ ...base, node: { isDir: false, restricted: true } });
    expect(actions(groups)[2]).toEqual(["access", "note"]);
  });

  it("marks delete as dangerous and puts the shortcut on open-in-tab", () => {
    const groups = treeRowMenu(base);
    expect(groups.at(-1)).toEqual([
      { kind: "action", action: "delete", label: "Delete", danger: true },
    ]);
    expect(groups[0]![0]).toMatchObject({ action: "openTab", hint: "⌘-click" });
  });
});

describe("rowMenuOnRightClick", () => {
  const wide = { compact: false, renaming: false, rowReadonly: false, workspaceTree: true };

  it("opens on a wide screen", () => {
    expect(rowMenuOnRightClick(wide)).toBe(true);
  });

  it("leaves the browser's menu on a compact screen or while renaming", () => {
    expect(rowMenuOnRightClick({ ...wide, compact: true })).toBe(false);
    expect(rowMenuOnRightClick({ ...wide, renaming: true })).toBe(false);
  });

  it("opens on a read-only row in the workspace's tree, for the ways to open it", () => {
    expect(rowMenuOnRightClick({ ...wide, rowReadonly: true })).toBe(true);
  });

  it("does nothing on a share's read-only tree", () => {
    expect(rowMenuOnRightClick({ ...wide, rowReadonly: true, workspaceTree: false })).toBe(false);
  });
});