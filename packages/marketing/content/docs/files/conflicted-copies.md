---
title: Conflicted copies
description: When two edits to the same file collide, Treehouse keeps both. Here's what a conflicted copy is, how to spot one and how to resolve it.
type: concept
position: 13
updated: 2026-09-29
related:
  - /docs/files/version-history
  - /docs/desktop/how-sync-works
  - /docs/agents/handbook/versions-and-conflicts
---

## Why they happen

Every save says which version of the file it was based on. Usually that's the latest one, and the save simply becomes the next version. But sometimes two people, or a person and an agent, start from the same version and both save. The first save wins and becomes the new version. The second is now based on an out-of-date version, so saving it over the top would silently throw away the first person's work.

Treehouse doesn't do that, and it doesn't throw away the second save either. It keeps the second save as a separate file next to the original: a conflicted copy. Both versions are safe, and a person or agent decides how to combine them.

If the two saves are identical, there's nothing to keep and no copy is made.

## How to recognise one

A conflicted copy sits in the same folder as the original, with a name like this:

```text
report (conflicted copy — human — 2026-09-29T10:15:00.000Z).md
```

- `human` or `agent` says whose save arrived second. The copy holds their version.
- The timestamp is when the copy was made, in UTC.
- If two copies would get the same name, the later one has ` (2)` added before the extension.

In the web app you'll also see:

- a **⚠** after the copy's name in the sidebar, with the tooltip `Conflicted copy — both versions kept; resolve manually`;
- a **1 conflicted copy** (or **N conflicted copies**) notice at the top of the original's details panel, linking to each copy;
- a banner in the editor if it was your own save that became the copy: "This file changed on the server, so your save was kept as a copy".

![A conflicted copy next to its original in the sidebar, marked with a warning sign, and the original's details panel showing a 1 conflicted copy notice that links to it](/docs/images/conflicted-copy.webp)

Copies of a private file stay private to the same person, and copies inside a private folder are covered by the folder.

## Edits beat deletes

The same rule works the other way. If someone deletes a file while you're editing it, your save brings the file back rather than being lost. An edit always wins over an out-of-date delete.

## Resolve a conflicted copy

1. Open the original and the copy, and compare them. The original's [history](/docs/files/version-history) shows who made each change.
2. Edit the original so it has everything you want to keep from both.
3. **Save** the original.
4. Delete the copy.

Treehouse never merges or deletes copies on its own. Until someone resolves it, the copy is an ordinary file.

::callout{type="agent"}
If you find a file whose name contains `(conflicted copy — `, don't ignore it and don't delete it unread. Read the original and the copy, merge the copy's changes into the original, write the original using its current version, then delete the copy. If the two versions contradict each other in a way you can't settle, leave both and tell a person.
::

## In a synced folder

The same thing happens on disk. If you edit a file in your synced folder while someone else changes it in the workspace, your version is saved under the conflicted-copy name in your folder, and the original is updated to their version. Nothing on your computer is lost. See [how sync works](/docs/desktop/how-sync-works).

For the protocol details, see [versions and conflicts](/docs/agents/handbook/versions-and-conflicts).