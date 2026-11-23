// The web app's view of local folders, via the desktop shell's bridge.
//
// The same app is served to a browser, where none of this exists. So every caller
// gets a defined shape either way: `available` is false in a browser and the list
// is empty, rather than callers having to guard `window.treehouse` themselves.
//
// The bridge is read-and-request: `folders` is state the shell owns, and the
// actions ASK the shell to do something. Nothing here changes anything directly —
// the shell performs every mutation behind a native dialog, so a caller cannot
// move or disconnect a folder by calling these.

export interface DesktopFolder {
  workspaceId: string;
  /** Display name only. The shell never sends a path. */
  folderName: string;
  paused: boolean;
}

interface TreehouseBridge {
  version: number;
  listFolders(): Promise<DesktopFolder[]>;
  connectFolder(workspaceId: string): Promise<void>;
  changeFolder(workspaceId: string): Promise<void>;
  revealFolder(workspaceId: string): Promise<void>;
}

function bridge(): TreehouseBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { treehouse?: TreehouseBridge }).treehouse ?? null;
}

/** One focus listener per page, however many components use the composable. */
let focusRefreshInstalled = false;

export function useDesktopFolders() {
  const folders = useState<DesktopFolder[]>("desktop:folders", () => []);
  const available = useState<boolean>("desktop:available", () => false);

  // The menubar changes folders too — Stop Syncing, Change Location, Add a Folder —
  // and nothing told the page, so it kept describing folders that had moved or
  // gone until something remounted it. Re-read whenever the window comes back to
  // the front: it is one cheap IPC call, and it is exactly the moment the user
  // returns from the menubar to look.
  if (import.meta.client && !focusRefreshInstalled && bridge()) {
    focusRefreshInstalled = true;
    window.addEventListener("focus", () => void refresh());
  }

  async function refresh() {
    const b = bridge();
    available.value = b !== null;
    if (!b) {
      folders.value = [];
      return;
    }
    try {
      folders.value = await b.listFolders();
    } catch {
      // An older shell may not know a channel. Degrade to "no folders" rather
      // than breaking the page around it.
      folders.value = [];
    }
  }

  /** The local folder for a workspace, or null when it has none (or in a browser). */
  function folderFor(workspaceId: string): DesktopFolder | null {
    return folders.value.find((f) => f.workspaceId === workspaceId) ?? null;
  }

  /** Ask the shell to act. Each resolves once the shell has finished — which
   * includes the user answering a native dialog, so these can take a while and
   * can complete having done nothing (the user cancelled). Refresh after. */
  // `finally`, not a straight line: an older shell can expose `treehouse` without a
  // given handler, and `ipcRenderer.invoke` on an unregistered channel REJECTS. That
  // skipped the refresh, so a failure left the panel showing whatever it believed
  // before — including, after a partial move, a folder name that no longer exists.
  // Refreshing on the way out costs one cheap read and keeps the UI honest; the
  // rejection still propagates so the caller can surface it.
  async function connect(workspaceId: string) {
    try {
      await bridge()?.connectFolder(workspaceId);
    } finally {
      await refresh();
    }
  }
  async function change(workspaceId: string) {
    try {
      await bridge()?.changeFolder(workspaceId);
    } finally {
      await refresh();
    }
  }
  async function reveal(workspaceId: string) {
    await bridge()?.revealFolder(workspaceId);
  }

  return { folders, available, refresh, folderFor, connect, change, reveal };
}