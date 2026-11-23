// Read the front matter of every markdown child of a folder, once, and derive
// what the folder views need from it: the calendar's dated entries, the board's
// cards, and the default page's own front matter (for `view:`, `title:` and
// `columns:`). Front matter is not in the folder listing, so each markdown
// child's bytes are read individually.
//
// One vue-query query per child (keyed by path + version) gives two things for
// free: a per-file cache (a revisit, or a drag that bumps one file, only
// re-reads what changed) and per-file error isolation (one unreadable child
// can't reject the others and blank the whole folder's calendar or board).
// Concurrency is bounded in practice by the browser's per-origin connection cap.
import { useQueries } from "@tanstack/vue-query";
import { splitFrontMatter } from "~/utils/frontmatter";
import type { FrontMatterData } from "~/utils/frontmatterData";
import { loadFrontMatterData } from "~/utils/frontmatterFields";
import {
  collectDatedChildren,
  type DatedChild,
  selectMarkdownCandidates,
} from "~/utils/folderDates";
import { type BoardCard, checklistCounts, toBoardCard } from "~/utils/board";
import type { FileSource } from "~/utils/fileSource";
import { findDefaultPage, type TreeNode } from "~/utils/treehouse";
import type { FileEntry } from "~/composables/useTreehouseApi";

interface ChildMeta {
  path: string;
  fm: FrontMatterData | null;
  /** Derived from the body at read time, so the body itself isn't cached. */
  checklist: { done: number; total: number } | null;
}

// `source` is where the child files are read from — the workspace API in the
// app, the token-scoped share API on a public link (see utils/fileSource.ts).
export function useFolderFrontMatter(
  source: Ref<FileSource>,
  children: Ref<TreeNode[] | null>,
  entries: Ref<FileEntry[]>,
) {
  // Versions come from the flat entry list, but scope the lookup to this
  // folder's children so an unrelated edit elsewhere in the workspace doesn't
  // churn the computed chain.
  const versionByPath = computed(() => {
    const paths = new Set((children.value ?? []).map((c) => c.path));
    const out = new Map<string, number>();
    for (const e of entries.value) {
      if (paths.has(e.path)) out.set(e.path, e.version);
    }
    return out;
  });
  const candidates = computed(() =>
    selectMarkdownCandidates(children.value ?? [], versionByPath.value),
  );

  const results = useQueries({
    queries: computed(() =>
      candidates.value.map((c) => {
        // Capture the source (and so its cache key) at query-creation time,
        // matching the queryKey, rather than reading the live ref inside the
        // queryFn — so a workspace switch mid-flight can't pair a new workspace
        // with this folder's old path.
        const src = source.value;
        return {
          queryKey: ["file-folder-meta", src.key, c.path, c.version] as const,
          queryFn: async (): Promise<ChildMeta> => {
            const text = await src.readText(c.path);
            const { frontMatter, body } = splitFrontMatter(text);
            return {
              path: c.path,
              fm: frontMatter ? (await loadFrontMatterData()).parseFrontMatter(frontMatter) : null,
              checklist: checklistCounts(body),
            };
          },
          enabled: !!src.key,
          staleTime: 5 * 60 * 1000,
        };
      }),
    ),
  });

  // The last successful read of each file, so a file whose new version is still
  // being read keeps its previous front matter instead of vanishing for a
  // moment. Without it, every write flickered: a moved card left the board until
  // its re-read landed, and a README write briefly lost `view: board`, which
  // sent the folder back to its front page and closed whatever panel was open.
  // Scoped by source key, so one workspace's front matter never stands in for
  // another's. Deliberately not reactive: it's a fallback, read inside the
  // computed below, and only ever written with data a query already returned.
  const lastRead = new Map<string, ChildMeta>();

  // Keyed by the path each result carries, not by array index. When a folder
  // change re-issues the query set, `candidates` and `results` can be momentarily
  // out of step; keying on the returned path means one folder's front matter can
  // never be misattributed to another's path during that transition. A child
  // with no successful read yet falls back to its last read, and one never read
  // is absent (treated as having no front matter).
  const metaByPath = computed(() => {
    const scope = source.value.key;
    const out = new Map<string, ChildMeta>();
    for (const r of results.value) {
      if (r?.isSuccess && r.data) {
        out.set(r.data.path, r.data);
        lastRead.set(`${scope}\u0000${r.data.path}`, r.data);
      }
    }
    for (const c of candidates.value) {
      if (out.has(c.path)) continue;
      const stale = lastRead.get(`${scope}\u0000${c.path}`);
      if (stale) out.set(c.path, stale);
    }
    return out;
  });
  const frontMatterByPath = computed<Record<string, FrontMatterData | null>>(() => {
    const out: Record<string, FrontMatterData | null> = Object.create(null);
    for (const [path, meta] of metaByPath.value) out[path] = meta.fm;
    return out;
  });

  const defaultPage = computed(() => findDefaultPage(children.value ?? []));

  const datedChildren = computed<DatedChild[]>(() =>
    collectDatedChildren(candidates.value, frontMatterByPath.value),
  );
  const hasDatedChildren = computed(() => datedChildren.value.length > 0);

  // Every read markdown child except the default page is a card, statused or
  // not — the unstatused ones fill the board's "No status" lane.
  const boardCards = computed<BoardCard[]>(() => {
    const conflicted = new Set(
      (children.value ?? []).filter((c) => c.conflicted).map((c) => c.path),
    );
    const out: BoardCard[] = [];
    for (const c of candidates.value) {
      if (c.path === defaultPage.value?.path) continue;
      const meta = metaByPath.value.get(c.path);
      if (!meta) continue;
      const card = toBoardCard({ ...c, conflicted: conflicted.has(c.path) }, meta.fm, "");
      out.push({ ...card, checklist: meta.checklist });
    }
    return out;
  });
  const hasStatusChildren = computed(() => boardCards.value.some((c) => c.status !== null));

  // Front matter of the folder's default page (README/index), for its `view:`
  // declaration, `title:` heading and a board's `columns:`. Null when there is
  // no default page or it isn't a parseable markdown file.
  const defaultPageFrontMatter = computed<FrontMatterData | null>(() => {
    const page = defaultPage.value;
    if (!page) return null;
    return frontMatterByPath.value[page.path] ?? null;
  });

  // True until every child's first read has settled, so a board doesn't flash
  // its empty state (or the wrong columns) before the reads land.
  const loading = computed(() => results.value.some((r) => r?.isPending));

  return {
    loading,
    datedChildren,
    hasDatedChildren,
    boardCards,
    hasStatusChildren,
    defaultPageFrontMatter,
  };
}