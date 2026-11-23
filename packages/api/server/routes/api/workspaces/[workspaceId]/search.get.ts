import { createError, getQuery } from "h3";
import { searchWorkspace } from "../../../../utils/search";
import { fileRoute, requireWorkspaceFromRoute } from "../../../../utils/workspace";

// Fuzzy search over the workspace's file and folder paths, ranked best-first by
// the same scorer the web sidebar and the MCP tools use.
//
// Results are permission-filtered for the caller before scoring and before the
// limit (see searchWorkspace) — a private node never appears, and never
// discloses its existence by displacing a result the caller may see.
//
// Deliberately top-N with no `offset`: ranked search's contract is "the best
// matches", and a query whose tail matters is a query to narrow. `totalMatches`
// says how much was cut off so that is an informed choice rather than an opaque
// one.
//
// Deliberately unthrottled. `/list` on the sibling route already does strictly
// more work per request and is polled by every CLI daemon every two seconds
// without a limit, so a search-only throttle would remove no capacity risk while
// introducing the first 429 on the key-authenticated data plane (auth.ts disables
// key rate limiting on purpose). Per-request cost is bounded by the clamped
// result limit and the path-only projection instead. If capacity ever becomes a
// real problem it belongs in middleware covering both routes, with shared state.

/** Long enough for any real query; bounds what lands in logs and error paths. */
const MAX_QUERY_LENGTH = 200;

export default fileRoute(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const query = getQuery(event);

  const q = typeof query.q === "string" ? query.q : "";
  if (!q.trim()) {
    // A constant message, never an echo of `q`. h3 puts statusMessage in the HTTP
    // reason phrase and Node throws ERR_INVALID_CHAR on CRLF, so echoing a query
    // containing newlines would turn this 400 into a 500.
    throw createError({ statusCode: 400, statusMessage: "Missing 'q'" });
  }
  if (q.length > MAX_QUERY_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: "Query too long" });
  }

  let limit: number | undefined;
  if (query.limit !== undefined) {
    if (typeof query.limit !== "string" || !/^\d+$/.test(query.limit)) {
      throw createError({ statusCode: 400, statusMessage: "Invalid 'limit'" });
    }
    // Out-of-range clamps rather than rejects (searchWorkspace owns the cap) —
    // clamping is the fail-safe direction and matches how MCP pages listings.
    limit = Number(query.limit);
  }

  const { results, totalMatches } = await searchWorkspace({
    workspaceId: ws.id,
    subject: access,
    query: q,
    limit,
  });

  return {
    results: results.map((r) => ({ path: r.path, name: r.name, isDir: r.isDir, score: r.score })),
    totalMatches,
    // Derived from the POST-filter match count. Deriving it before permission
    // filtering would make it a one-bit oracle on the existence of hidden matches.
    truncated: totalMatches > results.length,
  };
});