// Tags on notes: listing them and finding the notes that carry one. The single
// implementation behind the REST route and both MCP surfaces. Tags are read
// from each note by the link index (./link-index), which keeps them on the same
// row as its links: hashed keys in `targets` for lookups, and the names,
// encrypted, for listing.
//
// SECURITY: same posture as ./links.ts. Every answer is computed from what ONE
// actor may read: a private note's tags are never listed or counted for anyone
// who can't read it, so a tag can't disclose that a hidden note exists.
import { usePrismaClient } from "db";
import { tagKey, tidyTag } from "shared";
import { tagIndexKey } from "shared/linkScan";
import { catchUpLinkIndex, linkIndexKeyId, linkKeyHash, openTags } from "./link-index";
import type { AccessSubject } from "./acl";
import { readerView } from "./links";

export interface TagSummary {
  /** As first written (by path order) among the notes the actor can read. */
  tag: string;
  /** Readable notes carrying it, sorted. Not including notes under a nested tag. */
  paths: string[];
}

export interface TagsView {
  tags: TagSummary[];
  /**
   * False while notes written before the index existed are still being read,
   * so some tags or notes may be missing. Asking again makes progress.
   */
  complete: boolean;
}

/** Index rows (current key, readable to the actor) with their decrypted tags. */
async function readableTaggedRows(workspaceId: string, access: AccessSubject) {
  const view = await readerView(workspaceId, access);
  const rows = await usePrismaClient().fileLinks.findMany({
    where: { workspaceId, keyId: linkIndexKeyId(), tagNames: { not: null } },
    select: { sourcePath: true, tagNames: true },
    orderBy: { sourcePath: "asc" },
  });
  return rows
    .filter((r) => view.readable.has(r.sourcePath))
    .map((r) => ({ path: r.sourcePath, tags: openTags(workspaceId, r.tagNames) }));
}

/** Every tag on the notes `access` can read, with the notes carrying each. */
export async function listTags(opts: {
  workspaceId: string;
  access: AccessSubject;
}): Promise<TagsView> {
  const { workspaceId, access } = opts;
  if (!access?.userId) throw new Error("listTags requires a subject");
  const complete = await catchUpLinkIndex(workspaceId);
  const byKey = new Map<string, TagSummary>();
  for (const row of await readableTaggedRows(workspaceId, access)) {
    for (const tag of row.tags) {
      const entry = byKey.get(tagKey(tag)) ?? { tag, paths: [] };
      entry.paths.push(row.path);
      byKey.set(tagKey(tag), entry);
    }
  }
  const tags = [...byKey.values()].sort((a, b) => tagKey(a.tag).localeCompare(tagKey(b.tag)));
  // Code-point order, as everywhere else paths are listed (not the database's collation).
  for (const t of tags) t.paths.sort();
  return { tags, complete };
}

/**
 * The readable notes tagged `tag`, or with a tag nested under it (`project`
 * finds `#project/alpha`). Null when `tag` isn't a tag at all.
 */
export async function filesWithTag(opts: {
  workspaceId: string;
  access: AccessSubject;
  tag: string;
}): Promise<{ tag: string; paths: string[]; complete: boolean } | null> {
  const { workspaceId, access } = opts;
  if (!access?.userId) throw new Error("filesWithTag requires a subject");
  const tag = tidyTag(opts.tag);
  if (!tag) return null;
  const complete = await catchUpLinkIndex(workspaceId);
  const view = await readerView(workspaceId, access);
  const rows = await usePrismaClient().fileLinks.findMany({
    where: {
      workspaceId,
      keyId: linkIndexKeyId(),
      targets: { has: linkKeyHash(workspaceId, tagIndexKey(tagKey(tag))) },
    },
    select: { sourcePath: true },
  });
  const paths = rows
    .map((r) => r.sourcePath)
    .filter((p) => view.readable.has(p))
    .sort();
  return { tag, paths, complete };
}