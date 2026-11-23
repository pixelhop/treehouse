import { createError, getQuery } from "h3";
import { filesWithTag, listTags } from "../../../../utils/tags";
import { fileRoute, requireWorkspaceFromRoute } from "../../../../utils/workspace";

// Tags on notes. Without a query: every tag on a note the caller can read, with
// the notes carrying it. With `?tag=<tag>`: the notes carrying that tag or one
// nested under it (`project` finds `project/alpha`). Private notes the caller
// can't read are never counted or listed.
//
// `complete` is false while notes written before the index existed are still
// being read; asking again makes progress.
export default fileRoute(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const { tag } = getQuery(event);
  if (tag === undefined) return listTags({ workspaceId: ws.id, access });
  // filesWithTag answers null for anything that isn't a tag, an overlong one included.
  const found =
    typeof tag === "string" ? await filesWithTag({ workspaceId: ws.id, access, tag }) : null;
  // A constant message, never an echo of the query (see search.get.ts).
  if (!found) throw createError({ statusCode: 400, statusMessage: "Not a tag" });
  return found;
});