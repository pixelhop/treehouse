// TanStack Query (vue-query) with IndexedDB-persisted cache.
//
// Why: server reads (workspace, file list, file content, change feed, keys) get
// a shared cache with stale-while-revalidate — revisiting a file paints from
// cache instantly and refetches in the background. Persisting the cache to
// IndexedDB means a reload cold-opens on last-known data, then revalidates.
//
// Client-only (.client) — IndexedDB is browser-only and the app is an SPA.
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { del, delMany, get, keys, set } from "idb-keyval";
import { cacheStep, sessionIdentity } from "~/utils/queryCacheOwner";

const DAY = 1000 * 60 * 60 * 24;
/** Prefix of each person's stored cache; also matches the shared key used before. */
const CACHE_KEY_PREFIX = "treehouse:query-cache";

export default defineNuxtPlugin((nuxtApp) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // staleTime 0 → always revalidate in the background on mount/focus while
        // showing cached data. gcTime long so the persisted cache stays usable.
        staleTime: 0,
        gcTime: DAY,
        retry: 1,
        refetchOnWindowFocus: true,
      },
    },
  });

  nuxtApp.vueApp.use(VueQueryPlugin, { queryClient });

  // Persist the cache to IndexedDB (no ~5MB localStorage cap — file bodies fit).
  // One key per person, restored only once the session says who that is:
  // tabs share this storage, so a single key would let a tab still holding
  // Alice's data write it back after another tab signed in as Bob. A failed
  // restore (e.g. IndexedDB unavailable) is non-fatal — the app just refetches.
  const cacheKeyFor = (userId: string) => `${CACHE_KEY_PREFIX}:${userId}`;
  function persistFor(userId: string) {
    const persister = createAsyncStoragePersister({
      storage: {
        getItem: (k) => get<string>(k).then((v) => v ?? null),
        setItem: (k, v) => set(k, v),
        removeItem: (k) => del(k),
      },
      key: cacheKeyFor(userId),
    });
    const [stop, restored] = persistQueryClient({
      queryClient,
      persister,
      maxAge: DAY,
      // Bump to invalidate all persisted caches after a breaking shape change.
      // v2: the comment threads query became an infinite query under its existing
      // key, so a restored v1 entry is a bare CommentThreadView[] where the new
      // code expects { pages, pageParams }. Without this bump every existing
      // user's first load after deploy would restore the old shape and throw.
      buster: "v2",
    });
    void restored.catch((e) => console.warn("Treehouse: query cache restore failed", e));
    return stop;
  }

  /** Drop every stored cache but `userId`'s, whoever left it behind. */
  async function forgetOthers(userId: string | null) {
    const keep = userId ? cacheKeyFor(userId) : null;
    const stored = await keys().catch(() => []);
    const stale = stored.filter(
      (k) => typeof k === "string" && k.startsWith(CACHE_KEY_PREFIX) && k !== keep,
    );
    await delMany(stale).catch(() => {});
  }

  // The cache is shown only to the person it was fetched for: signing out, or
  // anyone else signing in, starts from nothing. Watching the session rather
  // than the sign-out buttons, for the reasons in plugins/posthog.client.ts.
  let heldBy: string | null = null;
  let stopPersisting: (() => void) | null = null;
  function switchTo(userId: string | null) {
    stopPersisting?.();
    stopPersisting = null;
    // Reset, not clear: mounted queries keep their observers and refetch. Only
    // when someone's data is held: on first load it's this session's already.
    if (heldBy !== null) void queryClient.resetQueries();
    heldBy = userId;
    void forgetOthers(userId);
    if (userId) stopPersisting = persistFor(userId);
  }

  const session = useAuthClient().useSession();
  watch(
    () => sessionIdentity(session.value),
    (identity) => {
      if (cacheStep(identity, heldBy) === "switch") switchTo(identity.userId);
    },
    { immediate: true },
  );
});