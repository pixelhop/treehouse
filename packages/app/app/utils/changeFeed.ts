// Decide whether a batch of change-feed events means the file currently open in
// the editor was changed on the server by someone else. A write whose version
// is greater than the version we loaded is a real under-edit change; our own
// save advances loadedVersion first, so its echoed event (version == loaded)
// does not trip this. A delete of the open path also counts.
import { opDisplay } from "./changeOps";

// The fields this check reads — a structural subset of ChangeFeedEvent, so the
// helper stays decoupled from the API client type (and cheaply testable).
export interface FileChangeEvent {
  path: string;
  op: string;
  version: number | null;
}

export function detectServerChange(
  events: FileChangeEvent[],
  path: string,
  loadedVersion: number,
): boolean {
  return events.some(
    (e) =>
      e.path === path &&
      (opDisplay(e.op).removesPath || (e.version != null && e.version > loadedVersion)),
  );
}