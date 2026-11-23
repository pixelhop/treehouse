// Workspace file search — the single implementation behind the REST route and
// both MCP `search_files` tools.
//
// SECURITY: this module is deliberately NOT part of files.ts. That module
// has a "trusted" viewer that skips permission enforcement (see `gateRead` and
// `list` there), and the unauthenticated public-share route relies on it. A search helper sitting in
// that file would inherit the convention by proximity — and because search
// returns paths from across the whole tree rather than one chosen prefix, an
// accidental bypass leaks far more than the same mistake in a listing. Here the
// actor is required and the helper fails closed.
//
// SECURITY: there are two different privacy filters in this codebase and they are
// not interchangeable. `canRead(acls, path, subject)` — used here, via
// `listPaths` — answers "may THIS user read it". The unauthenticated share
// listing instead uses `!effectiveAcl(acls, path)` ("is it private to anyone at
// all") plus scoping to the share's own path prefix. This helper must never be
// reused to build a share-scoped search: it has no prefix parameter, and the
// prefix scope is the load-bearing control there. See
// docs/solutions/architecture-patterns/public-share-trust-boundary.md.
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, isKeepFile, searchPaths } from "shared";
import type { SearchItem, SearchResult } from "shared";
import { type AccessSubject, listWorkspaceAcls } from "./acl";
import { useFileService } from "./files";

export interface SearchWorkspaceOptions {
  workspaceId: string;
  /** Required and never "trusted" — see the module note. */
  subject: AccessSubject;
  query: string;
  limit?: number;
}

export interface SearchWorkspaceOutcome {
  results: SearchResult[];
  /** Matches before the limit was applied, so callers can report truncation. */
  totalMatches: number;
}

/**
 * Rank a workspace's files and folders against `query` for one actor.
 *
 * Arguments arrive as an options object rather than positionally: `workspaceId`
 * and `query` are both strings, so a positional signature lets a
 * transposition typecheck cleanly.
 */
export async function searchWorkspace(
  options: SearchWorkspaceOptions,
): Promise<SearchWorkspaceOutcome> {
  const { workspaceId, query } = options;
  const subject = options.subject;
  // Fail closed, and throw rather than return empty: an empty result set looks
  // like "nothing matched" and would hide the bug at every call site.
  if (!subject?.userId) throw new Error("searchWorkspace requires a subject");

  const acls = await listWorkspaceAcls(workspaceId);
  // Permission filtering happens HERE — before scoring, before the limit.
  // Filtering after a limit silently drops results the caller is entitled to see.
  const paths = await useFileService().listPaths(workspaceId, subject, acls);

  // SECURITY: synthesize folders from the ACL-FILTERED list, never the raw one.
  // Building ancestors from unfiltered paths would hand back the names of folders
  // whose files are all private to somebody else.
  //
  // Ancestors are derived from every readable path INCLUDING `.keep`
  // placeholders, and only then are the `.keep` files themselves dropped. The
  // order matters: a folder that exists only because of a placeholder is real and
  // visible in the sidebar (buildTree skips only the leaf), so dropping `.keep`
  // first would make it findable in the UI and invisible to search — breaking the
  // promise that a human and an agent get the same answer.
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }

  const items: SearchItem[] = [];
  for (const path of folders) {
    items.push({ path, name: path.slice(path.lastIndexOf("/") + 1), isDir: true });
  }
  for (const path of paths) {
    if (isKeepFile(path)) continue;
    items.push({ path, name: path.slice(path.lastIndexOf("/") + 1), isDir: false });
  }

  // Clamped internally so the cap holds regardless of what a caller passes —
  // same posture as pageEntries() in the MCP server, whose comment reads "the
  // safety cap must always hold". Without it, a one-character query with a huge
  // limit is the cheapest way to dump an entire workspace.
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT)),
    MAX_SEARCH_LIMIT,
  );
  const outcome = searchPaths(query, items, { limit });
  return { results: outcome.results, totalMatches: outcome.totalMatches };
}

// Scaling notes, for when this stops being fast enough:
//
// Today the whole readable listing is read and scored in JavaScript per request
// — single-digit milliseconds at a few thousand paths. That is deliberate: it is
// the simple implementation and it shares one ranking function with the client.
//
// If workspaces grow by an order of magnitude, the fix is a database-side
// prefilter (a pg_trgm trigram index on file_node.path) narrowing candidates
// before scoring. Do not build it speculatively — it forks the ranking between
// SQL and JavaScript, which is the thing the shared scorer exists to prevent.
//
// If a candidate cache is added instead, the cache key must be the workspace's
// RAW path list only, with ACL filtering applied per request per actor AFTER the
// cache. An actor-agnostic cache of the filtered list is a cross-member leak.