import { createError, getQuery } from "h3";
import { getLinks } from "../../../../utils/links";
import {
  assertInKeyFolder,
  fileRoute,
  requirePathQuery,
  requireWorkspaceFromRoute,
} from "../../../../utils/workspace";

// Links between notes for one file. Query: ?path=<path>, plus `outgoing=1` to
// also resolve the links the file itself makes. Returns the notes that link to
// it ("backlinks"), filtered to what the caller may read — a private note never
// appears, and a private file answers 404 exactly like a missing one.
//
// `complete` is false while notes written before the link index existed are
// still being indexed; asking again makes progress.
export default fileRoute(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const path = requirePathQuery(event);
  assertInKeyFolder(access, path);
  const links = await getLinks({
    workspaceId: ws.id,
    access,
    path,
    outgoing: getQuery(event).outgoing === "1",
  });
  if (!links) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return links;
});