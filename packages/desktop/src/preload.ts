import { contextBridge, ipcRenderer } from "electron";
import {
  appOriginFromArgv,
  BRIDGE_CHANNELS,
  BRIDGE_VERSION,
  type BridgeFolder,
  mayExposeBridge,
} from "./bridge";

// The ONLY privileged surface the remote page can see. Runs sandboxed, with
// context isolation on, so `contextBridge` is the sole way anything crosses into
// the page's world — nothing here leaks a Node primitive.
//
// Every method is a request to the main process. None of them does the work: the
// handlers on the other side perform it, and every mutation goes through a native
// dialog the user answers. So the worst a compromised page can do with this is
// make a dialog appear.
//
// The app origin is baked in at build time rather than read from the page — a
// page asking "am I allowed?" and being believed would defeat the check.

// The origin comes from the shell, per window, via additionalArguments. NOT baked
// at build time: a self-hosted instance and a dev run each have their own origin,
// and a baked one would withhold the bridge from both. Absent → expose nothing.
const appOrigin = appOriginFromArgv(process.argv);

if (appOrigin !== null && mayExposeBridge(window.location.origin, appOrigin)) {
  contextBridge.exposeInMainWorld("treehouse", {
    version: BRIDGE_VERSION,
    listFolders: (): Promise<BridgeFolder[]> => ipcRenderer.invoke(BRIDGE_CHANNELS.listFolders),
    connectFolder: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(BRIDGE_CHANNELS.connectFolder, workspaceId),
    changeFolder: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(BRIDGE_CHANNELS.changeFolder, workspaceId),
    revealFolder: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(BRIDGE_CHANNELS.revealFolder, workspaceId),
  });
}