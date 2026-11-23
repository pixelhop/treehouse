---
title: Control who can see a file or folder
navTitle: Private and restricted files
description: Keep a file or folder to yourself, or share it with specific people as Viewers or Editors, even in a workspace you share with others.
type: how-to
position: 14
updated: 2026-11-09
related:
  - /docs/files/organise-files
  - /docs/sharing/share-links
  - /docs/agents/connect/how-agents-work
---

Everything in a workspace is visible to every member unless you restrict it. There are two ways to do that:

- **Private:** only you, and anything using your access: your API keys, your agents and your synced folders.
- **Shared with specific people:** only the members you choose, each as a **Viewer** (can read and comment) or an **Editor** (can change it).

Either way, nobody else in the workspace can see it, and that includes the workspace's owners and admins. Holding a role never gets someone into a restricted folder.

This only matters once someone else has joined the workspace. On Seedling, where a workspace has one member, everything is already yours alone.

## Share a file or folder with specific people

1. Open its row menu in the sidebar tree (hover over the row and select **⋯**, or right-click it) and select **Who can access…**. On a phone, tap the **⋯** at the end of the row.
2. It starts open, with everyone as an **Editor**. Set **Everyone else** to **No access** to keep it to the people you choose, or to **Viewer** so everyone can read it and only the people you choose can change it. Leaving it on **Editor** lets anyone in except the people you set to **No access**.
3. Next to each member, choose **No access**, **Viewer** or **Editor**.
4. Select **Save**. On something that isn't restricted yet, leaving everyone as an Editor saves nothing, and it stays open.

Inside a restricted folder, the dialog starts from who can reach it through that folder. Saving gives the item its own list, which replaces the folder's for that item. **No access** next to someone keeps them out even when **Everyone else** can view.

A people icon now appears after its name, with the tooltip `Only the people it's shared with can see this`. You stay an **Editor**, so you can't lock yourself out. Editors can change who has access; Viewers can't.

A [Viewer on the workspace](/docs/sharing/invite-people#roles) is only ever offered **Viewer** here, because a grant can't give someone more than their role.

To open it up again, choose **Who can access**, then **Open to everyone**.

## Make a file or folder private

You need to be able to edit the workspace, so [Viewers](/docs/sharing/invite-people#roles) can't make things private.

1. Open its row menu in the sidebar tree (hover over the row and select **⋯**, or right-click it). On a phone, tap the **⋯** at the end of the row.
2. Select **Make private**.

A lock now appears after its name, with the tooltip `Private — only you and your agents can see this`.

## Make it shared again

1. Open the private file or folder's row menu (**⋯**).
2. Select **Make shared**.

Only the person who made something private can share it again. Nobody else can see it to try.

## Private folders

Making a folder private makes everything in it private, including files added later by you or your agents. Items inside show a faded lock, with the tooltip `Private — inherited from a parent folder. Make the parent folder shared to change this.` To share one of them, make the folder shared, or move the item out of it.

Moving things changes what's covered:

- A file moved into a private folder becomes private.
- A file moved out of a private folder becomes visible to everyone, unless the file itself was marked private.
- A file you marked private yourself stays private wherever you move it.

## What other members see

To everyone who can't reach it, a private or restricted item doesn't exist:

- It isn't in their file tree or their search results, and its changes don't appear in their activity feed. The one exception is a single **restricted** entry, with its name, at the moment it was hidden from them.
- A direct link to it shows that the file isn't in the workspace, as if it had never been there.
- Their agents and API keys get "Not found" when they try to read, write, move or delete it.
- It never appears in a file's **Linked from** list, even when it links to that file, and it never changes where their [wikilinks](/docs/files/link-notes) lead. Its [tags](/docs/files/tag-notes) are never listed or counted for them either.
- When something is restricted, it's removed from their synced folders. When they're given access, it comes back.

[Conflicted copies](/docs/files/conflicted-copies) of a private file are private too.

## Limits

- Private and restricted items can't have share links, public or member. A link would reach people the restriction leaves out, so links stop working while an item is restricted, and work again if it's opened up. To share something, copy it into a file that isn't restricted. See [share a file with a link](/docs/sharing/share-links).
- A restriction on a folder replaces any above it, it doesn't add to them. Someone can have access to a folder inside one they can't see.
- **Make private** isn't offered on something shared with specific people, because it would drop them. Use **Who can access** instead.
- Restrictions control who can see a file inside Treehouse. Anyone you give one of your API keys to, or who can open your synced folder on your computer, can see what you can.

## If everyone with access leaves

When every person who could reach an item has left the workspace, nobody can see it, but its files still count toward your storage. A workspace owner can recover it:

1. Open **Members** from the account menu. **Items nobody can reach** lists these by name. Owners can't see inside them.
2. Select **Take over**, then confirm.

The owner becomes its Editor, and the [activity feed](/docs/sharing/activity) shows that they did, to owners and admins. This is the one way past a restriction, and only works once no remaining member has access.

## Check it worked

Look for the lock or the people icon after the name in the sidebar. To be certain, ask another member whether the file appears in their tree. It shouldn't.