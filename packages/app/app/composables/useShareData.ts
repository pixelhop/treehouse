// Shared state for the public share viewer — the counterpart to
// useWorkspaceData, backed by the token-scoped share API instead of the
// authenticated workspace one. It deliberately mirrors that composable's shape
// (entries / tree / selectedPath / selectedEntry / selectedFolder / select) so
// the viewer components can be the same ones the app uses.
//
// Paths here are FULL workspace paths, exactly as the share API expects them
// (`?path=` on the file route, `?p=` in the viewer URL). The tree is rooted at
// the shared folder by descending into it after building, so nothing has to
// strip prefixes and node names come out right.
import { useQuery } from "@tanstack/vue-query";
import { isKeepFile } from "shared";
import type { FileSource } from "~/utils/fileSource";
import { buildTree, findNode } from "~/utils/treehouse";
import type { ShareFile } from "~/composables/usePublicShare";

/** HTTP status of a failed $fetch, whichever field this ofetch version sets. */
function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number } | null;
  return e?.status ?? e?.statusCode;
}
/** A share API call that failed because the unlock cookie is missing/expired. */
function isLocked(err: unknown): boolean {
  return statusOf(err) === 401;
}

export function useShareData(token: Ref<string>) {
  const route = useRoute();
  const { metaQuery, unlock, fileUrl, downloadUrl, readFileText, listUrl } = usePublicShare(token);

  const meta = computed(() => metaQuery.data.value ?? null);
  const kind = computed(() => meta.value?.kind ?? null);
  const sharePath = computed(() => meta.value?.file?.path ?? "");

  // The password gate. Seeded from the meta response (so an already-unlocked
  // visitor never sees it) and re-raised if a later call 401s — the unlock
  // cookie is short-lived, so a long-open tab can fall back out of unlocked.
  const relocked = ref(false);
  const locked = computed(
    () => !!meta.value?.hasPassword && (relocked.value || !meta.value.unlocked),
  );

  const listQuery = useQuery({
    queryKey: computed(() => ["share-list", token.value]),
    queryFn: () =>
      $fetch<{
        path: string;
        entries: ShareFile[];
        icons: Record<string, string>;
        orders: Record<string, number>;
      }>(listUrl(), { credentials: "include" }),
    enabled: computed(() => kind.value === "folder" && !locked.value),
    retry: false,
  });
  watch(
    () => listQuery.error.value,
    (err) => {
      if (isLocked(err)) relocked.value = true;
    },
  );

  const root = computed(() => listQuery.data.value?.path ?? "");
  // The listing includes `.keep` placeholders so empty folders exist in the
  // tree. They build it (buildTree skips them as leaves) but are never files.
  const listed = computed<ShareFile[]>(() => listQuery.data.value?.entries ?? []);
  const entries = computed<ShareFile[]>(() => {
    if (kind.value === "file") return meta.value?.file ? [meta.value.file] : [];
    return listed.value.filter((e) => !isKeepFile(e.path));
  });

  // Build the whole path tree, then descend to the shared folder so the viewer's
  // top level is the share's own children rather than the chain of ancestors
  // leading down to it.
  const tree = computed(() => {
    const full = buildTree(
      kind.value === "folder" ? listed.value : entries.value,
      listQuery.data.value?.icons ?? {},
      listQuery.data.value?.orders ?? {},
    );
    if (!root.value) return full;
    return findNode(full, root.value)?.children ?? [];
  });

  // --- selection (URL-driven, so a file inside a share is linkable) ---
  const selectedPath = computed(() => {
    if (kind.value === "file") return sharePath.value;
    const p = route.query.p;
    return typeof p === "string" ? p : "";
  });
  const selectedEntry = computed(
    () => entries.value.find((e) => e.path === selectedPath.value) ?? null,
  );
  const selectedFolder = computed(() =>
    selectedPath.value && !selectedEntry.value ? findNode(tree.value, selectedPath.value) : null,
  );

  function select(node: { path: string; isDir: boolean } | null) {
    void navigateTo({ query: node?.path ? { p: node.path } : {} });
  }

  // Reading file bytes. A single-file share serves exactly one path — it can't
  // reach siblings — so `reachesSiblings` is false there and the viewers leave
  // that document's relative references alone rather than resolving every one of
  // them back to the shared file itself.
  const fileSource = computed<FileSource>(() => ({
    key: token.value,
    readText: async (path) => {
      try {
        return await readFileText(kind.value === "file" ? undefined : path);
      } catch (err) {
        if (isLocked(err)) {
          relocked.value = true;
          throw new Error("This link is password-protected.");
        }
        if (statusOf(err) === 410) {
          throw new Error("This version is no longer available.");
        }
        throw err;
      }
    },
    fileUrl: (path) => fileUrl(kind.value === "file" ? undefined : path),
    downloadUrl: (path) => downloadUrl(kind.value === "file" ? undefined : path),
    pageUrl: (path) =>
      kind.value === "folder"
        ? `/s/${token.value}?p=${encodeURIComponent(path)}`
        : `/s/${token.value}`,
    reachesSiblings: kind.value === "folder",
    // A folder share's wikilinks resolve among its own files only: a note
    // outside the share isn't something this link can reach.
    paths: kind.value === "folder" ? () => entries.value.map((e) => e.path) : undefined,
  }));

  async function submitPassword(password: string) {
    await unlock(password);
    relocked.value = false;
    // Re-read the meta: it carries `unlocked`, and a file share's entry is only
    // described once the gate is passed.
    await metaQuery.refetch();
  }

  // Media (images, downloads) is fetched by the browser from a URL, so a 401
  // from an expired unlock cookie never passes through `readText`. Re-reading
  // the meta is how that failure becomes the password gate again instead of a
  // silently broken image.
  async function recheckLock() {
    if (!meta.value?.hasPassword) return;
    await metaQuery.refetch();
  }

  const loading = computed(
    () => metaQuery.isPending.value || (kind.value === "folder" && listQuery.isPending.value),
  );
  /**
   * The workspace has hit its monthly share allowance, so this link is dark
   * until it resets or its owner upgrades. Distinct from notFound: the link is
   * real and will work again, and the page must say so without blaming anyone.
   */
  const paused = computed(() => {
    const err = metaQuery.error.value as { statusCode?: number; status?: number } | null;
    if (!err) return false;
    return (err.statusCode ?? err.status) === 402;
  });
  const notFound = computed(() => metaQuery.status.value === "error" && !paused.value);

  return {
    token,
    meta,
    kind,
    locked,
    loading,
    notFound,
    paused,
    root,
    entries,
    tree,
    selectedPath,
    selectedEntry,
    selectedFolder,
    select,
    fileSource,
    submitPassword,
    recheckLock,
  };
}