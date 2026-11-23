// The decisions behind predictive file loading (composables/usePrefetchFile.ts),
// kept free of Vue and the query client so they can be tested.

/** Bigger than this, a file's bytes wait for a real click. */
export const MAX_PREFETCH_BYTES = 512 * 1024;
/** At most this many prefetches at once, so sweeping a long tree can't flood the API. */
export const MAX_IN_FLIGHT = 2;

interface ListedEntry {
  path: string;
  size: number;
}

/**
 * The listed entry a prefetch for `path` would warm, or null when there is
 * nothing to do: on the server, on a public share (which reads through its own
 * token-scoped source and cache key, so the workspace's bytes would be the wrong
 * ones), before a workspace is open, or for a path the listing doesn't have (a
 * folder, or something already gone).
 */
export function prefetchTarget<E extends ListedEntry>(o: {
  client: boolean;
  routePath: string;
  workspaceId: string | null;
  path: string;
  /** The cached file listing, if it has loaded. */
  listing: { entries: E[] } | undefined;
}): { workspaceId: string; entry: E } | null {
  const usable = o.client && !o.routePath.startsWith("/s/") && !!o.workspaceId && !!o.path;
  const entry = usable ? o.listing?.entries.find((e) => e.path === o.path) : undefined;
  return entry ? { workspaceId: o.workspaceId as string, entry } : null;
}

/**
 * Whether to fetch a file's body ahead of the click: only kinds rendered from
 * their text, only small files, never twice, and never past the in-flight cap.
 */
export function shouldPrefetchBody(o: {
  needsBody: boolean;
  size: number;
  /** The query's current state, if it has one. */
  state: { data?: unknown; fetchStatus?: string } | undefined;
  inFlight: number;
}): boolean {
  const wanted = o.needsBody && o.size <= MAX_PREFETCH_BYTES;
  const known = o.state?.data !== undefined || o.state?.fetchStatus === "fetching";
  return wanted && !known && o.inFlight < MAX_IN_FLIGHT;
}