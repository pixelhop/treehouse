// The one write path for "change a key in a file's front matter": the calendar's
// drag-to-reschedule and every board action (a card's status, order or assignee;
// a board README's view or columns). Reuses the version-CAS file write — read
// the current bytes + version, patch the block, conditional PUT — so it is just
// another front-matter edit: untouched files stay byte-identical, and a stale
// write is kept as a conflicted copy by the server rather than lost. No new
// endpoint.
import { splitFrontMatter } from "~/utils/frontmatter";
import type { FrontMatterData } from "~/utils/frontmatterData";
import { loadFrontMatterData } from "~/utils/frontmatterFields";

export type FrontMatterWriteResult =
  | { status: "ok" }
  | { status: "conflict"; conflictCopyPath?: string }
  | { status: "error" };

/**
 * The keys to change (`undefined` removes one), or a function that works them
 * out from the front matter as it is read for this very write — so a change
 * that depends on the current value (toggling an assignee, renaming a status)
 * is decided against the same bytes the CAS write is based on, never against
 * whatever the screen happened to show. Returning null writes nothing.
 */
export type FrontMatterPatch =
  | Record<string, unknown>
  | ((current: FrontMatterData | null) => Record<string, unknown> | null);

// Writes to one file run one at a time. Two quick edits to the same card (two
// assignees picked in a row, a drag then a Move to…) would otherwise both read
// the same version, and the second would lose the race and become a conflicted
// copy. Chained, each reads the version the one before it wrote. Module-level
// so the calendar and every board share the queue.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

export function useFrontMatterWrite() {
  const ws = useWorkspaceData();
  const api = useTreehouseApi();

  /**
   * Patch `path`'s front matter. Pass `refresh: false` when writing several
   * files in a row, and refresh once at the end instead. Pass `workspaceId` to
   * pin a batch to the workspace it started in: without it, a batch still
   * running after you switch workspace would write the rest of its paths into
   * the new one.
   */
  function patch(
    path: string,
    fields: FrontMatterPatch,
    opts: { refresh?: boolean; workspaceId?: string } = {},
  ): Promise<FrontMatterWriteResult> {
    const id = opts.workspaceId ?? ws.workspaceId.value;
    if (!id) return Promise.resolve({ status: "error" });
    return serialized(`${id}\u0000${path}`, async (): Promise<FrontMatterWriteResult> => {
      try {
        const [{ body, version }, { parseFrontMatter, setFrontMatterFields }] = await Promise.all([
          api.readFileWithMeta(id, path),
          loadFrontMatterData(),
        ]);
        if (version === null) return { status: "error" };
        let changes: Record<string, unknown> | null;
        if (typeof fields === "function") {
          const { frontMatter } = splitFrontMatter(body);
          changes = fields(frontMatter ? parseFrontMatter(frontMatter) : null);
          if (changes === null) return { status: "ok" };
        } else {
          changes = fields;
        }
        const next = setFrontMatterFields(body, changes);
        // A patch that changes nothing produces identical bytes — skip the write.
        if (next === body) return { status: "ok" };
        const res = await api.writeFile(id, path, next, { baseVersion: version });
        if (res.ok) return { status: "ok" };
        return { status: "conflict", conflictCopyPath: res.conflictCopyPath };
      } catch {
        return { status: "error" };
      } finally {
        // Revalidate on every path that attempted a read/write — including a
        // throw — so a failed attempt can't strand the entries cache on a stale
        // version that makes the next drag conflict against bytes it never saw.
        if (opts.refresh !== false) ws.refresh();
      }
    });
  }

  return { patch };
}