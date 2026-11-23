import { basename } from "node:path";
import { relocateFolder } from "cli/src/relocate";
import { loadLinks } from "cli/src/links-store";
import { dialog, ipcMain, shell } from "electron";
import { BRIDGE_CHANNELS, type BridgeFolder, isValidWorkspaceId } from "./bridge";
import { promptForNewLocation } from "./relocate-prompt";

// The main-process half of the bridge. The page can ASK for these; it cannot do
// them. Each mutation runs here, behind a native dialog, on a path the page never
// sees — it only ever sends a workspace id, and an unrecognised one is a no-op.
//
// Wired code: the decisions it leans on (`planRelocation`, `isValidWorkspaceId`)
// are pure and tested elsewhere; this is the glue, covered by the QA checklist.

/** Resolve a page-supplied workspace id to a real link, or null. Validation is
 * first: an id that isn't shaped like one never reaches the registry. */
function linkFor(workspaceId: unknown) {
  if (!isValidWorkspaceId(workspaceId)) return null;
  return loadLinks().find((l) => l.workspaceId === workspaceId) ?? null;
}

export interface BridgeActions {
  /** Start the connect-a-folder flow for a workspace with no folder yet, and
   * resolve when it has finished (or been abandoned) — NOT when it has started.
   * The page refreshes its folder list on resolution, so resolving early would
   * re-read the registry before the link exists and leave the workspace showing
   * as folderless until something else triggered a reload. */
  connectFolder(workspaceId: string): Promise<void>;
  /** Refresh the tray after the registry changes. */
  refresh(): Promise<void>;
}

export function registerBridgeHandlers(actions: BridgeActions): void {
  // READ — basenames only. The page never learns a path.
  ipcMain.handle(BRIDGE_CHANNELS.listFolders, (): BridgeFolder[] =>
    loadLinks().map((l) => ({
      workspaceId: l.workspaceId,
      folderName: basename(l.root),
      paused: l.paused === true,
    })),
  );

  // REQUEST — connect a folder for a workspace that has none.
  ipcMain.handle(BRIDGE_CHANNELS.connectFolder, async (_e, workspaceId: unknown) => {
    if (!isValidWorkspaceId(workspaceId)) return;
    // Already connected → nothing to do. One folder per workspace per Mac.
    if (loadLinks().some((l) => l.workspaceId === workspaceId)) return;
    // Awaited: the caller refreshes on resolution, so this must not resolve until
    // the flow has actually written (or not written) a link.
    await actions.connectFolder(workspaceId);
  });

  // REQUEST — move an existing folder. The user picks the destination in a native
  // dialog; the page cannot name one, so it can't aim this at a path of its
  // choosing.
  ipcMain.handle(BRIDGE_CHANNELS.changeFolder, async (_e, workspaceId: unknown) => {
    const link = linkFor(workspaceId);
    if (!link) return;

    const destination = await promptForNewLocation(link.root);
    if (destination === null) return;

    // `relocateFolder` REFUSES by returning { ok: false } but THROWS when a step
    // fails midway — the thrown message is the only thing that says where the files
    // ended up. Letting that reject the IPC call showed the user nothing at all and
    // skipped the refresh below, so the tray and the page both kept stale state.
    // The tray path already handles both; this one has to match it.
    try {
      const result = await relocateFolder(link.root, destination);
      if (!result.ok) {
        await dialog.showMessageBox({
          type: "warning",
          title: "Treehouse",
          message: "Couldn't move that folder",
          detail: result.message,
          buttons: ["OK"],
        });
      }
    } catch (err) {
      await dialog.showMessageBox({
        type: "warning",
        title: "Treehouse",
        message: `Couldn't finish moving “${basename(link.root)}”`,
        detail: err instanceof Error ? err.message : String(err),
        buttons: ["OK"],
      });
    }
    // Refresh either way: a partial move still changed the registry.
    await actions.refresh();
  });

  // REQUEST — reveal in Finder. Read-only, but still resolved from the registry
  // rather than from anything the page supplies.
  ipcMain.handle(BRIDGE_CHANNELS.revealFolder, (_e, workspaceId: unknown) => {
    const link = linkFor(workspaceId);
    if (link) shell.showItemInFolder(link.root);
  });
}