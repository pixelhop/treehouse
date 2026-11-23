// Predictive loading: start fetching a file the moment someone shows intent to
// open it — resting the pointer on its tree row, search result or tab — so the
// click lands on bytes (and viewer code) that are already here.
//
// The bytes go into the SAME vue-query cache entry FileViewer reads, keyed
// ["file", workspaceId, path, version] with an infinite staleTime (content is
// immutable for a version). Nothing else changes: when the viewer mounts it
// finds the entry filled, or joins the request already in flight.
//
// Deliberately cheap to call from every row:
// - it reads the workspace id from shared state and the listing from the query
//   cache, rather than through useWorkspaceData (four observers per call), since
//   FileTree runs one instance per rendered folder;
// - intent is gated: only a pointer that RESTS on a row for HOVER_INTENT_MS
//   fetches, and a newer hover replaces an older one, so sweeping the pointer
//   down a long tree costs nothing;
// - large files and anything without a text body are skipped (media streams
//   from its URL anyway), and only a couple run at once (utils/prefetch.ts).
import { useQueryClient } from "@tanstack/vue-query";
import { ACTIVE_WS_KEY } from "~/utils/workspaceState";
import { viewerKind } from "~/utils/treehouse";
import { VIEWERS } from "~/utils/viewers";
import { prefetchTarget, shouldPrefetchBody } from "~/utils/prefetch";
import type { FileEntry } from "~/composables/useTreehouseApi";

const HOVER_INTENT_MS = 80;

// Module scope: one pointer, so one pending hover across every tree instance.
let pending: { path: string; timer: ReturnType<typeof setTimeout> } | null = null;
let inFlight = 0;

function cancelPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending = null;
}

export function usePrefetchFile() {
  const qc = useQueryClient();
  const api = useTreehouseApi();
  const route = useRoute();
  const workspaceId = useState<string | null>(ACTIVE_WS_KEY, () => null);

  /** Prefetch a workspace path now (a folder or unknown path is a no-op). */
  function prefetchPath(path: string): void {
    const target = prefetchTarget({
      client: import.meta.client,
      routePath: route.path,
      workspaceId: workspaceId.value,
      path,
      listing: qc.getQueryData<{ entries: FileEntry[] }>(["entries", workspaceId.value]),
    });
    if (!target) return;
    const { workspaceId: ws, entry } = target;

    const def = VIEWERS[viewerKind(entry.contentType, entry.path)];
    // The renderer's code, whatever the size: it's shared by every file of the kind.
    def.preload().catch(() => {
      // A failed chunk is reported properly when the viewer itself mounts.
    });

    const queryKey = ["file", ws, entry.path, entry.version];
    const go = shouldPrefetchBody({
      needsBody: def.needsBody,
      size: entry.size,
      state: qc.getQueryState(queryKey),
      inFlight,
    });
    if (!go) return;
    inFlight++;
    void qc
      .prefetchQuery({
        queryKey,
        queryFn: () => api.readFile(ws, entry.path),
        staleTime: Number.POSITIVE_INFINITY,
      })
      .finally(() => {
        inFlight--;
      });
  }

  /** The pointer arrived on a row: prefetch if it stays there. */
  function hover(path: string): void {
    cancelPending();
    pending = {
      path,
      timer: setTimeout(() => {
        pending = null;
        prefetchPath(path);
      }, HOVER_INTENT_MS),
    };
  }

  /** The pointer left a row before the intent delay ran out. */
  function leave(path: string): void {
    if (pending?.path === path) cancelPending();
  }

  return { prefetchPath, hover, leave };
}