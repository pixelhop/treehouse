---
title: Share a file or folder with a link
navTitle: Share links
description: Send members straight to a file, or give anyone read-only access to a file or folder, with an optional password and a pinned version.
type: how-to
position: 2
updated: 2026-10-30
related:
  - /docs/sharing/invite-people
  - /docs/files/html-pages
  - /docs/files/version-history
  - /docs/account/plans-and-limits
---

Every file and folder has two kinds of link, both in the **Share** tab of the right-hand panel:

- **A member link** goes straight to the file in the workspace. It only works for signed-in members, so it's for pointing a teammate at something.
- **A public link** lets anyone who has it read the file or folder, with no account. It's for clients, readers and anyone outside the team.

## Copy a member link

1. Open the file, or select the folder.
2. In the right-hand panel, open the **Share** tab.
3. Beside **Members of this workspace**, select **Copy link**.

## Create a public link

Public links have to be created by a person signed in to the web app. Agents and API keys can create member links, but not public or password-protected ones, so a leaked key can never open your files to the world.

1. Open the file, or select the folder, and open the **Share** tab.
2. Beside **Anyone with the link**, select **Create link**.
3. Optionally, tick **Password protect** and enter a password. Visitors will need it to see anything.
4. For a file, choose a **Link target**:
   - **Live (always latest)** shows whatever the file says now, and keeps up as it changes.
   - **Pinned to v**_N_ keeps showing this exact version, even after the file changes. Use this for anything you're sending to a client as final.
5. For a single HTML file, you can also tick **Let the page run its scripts**. See [HTML pages](/docs/files/html-pages) before you do.
6. Select **Create and copy link**. The link is created and copied to your clipboard, and the panel says **Link created and copied to your clipboard**.

![The Share tab for a file, with a public link showing its view count and Copy and Revoke buttons](/docs/images/share-panel.webp)

Each file or folder has one public link. Once it exists, the panel shows how often it's been opened ("12 views · last opened 2 hours ago", or "Not opened yet"), a lock if it has a password, the pinned version if there is one, and **Copy link** and **Revoke** buttons.

A folder link covers everything inside that folder, including files added later. It doesn't cover anything outside it, even a sibling folder with a similar name. If a parent folder is already public, the panel says **Shared publicly via a parent folder** and links to it. Select **Copy link to this file** to copy the folder's link opened straight onto that file; a password-protected folder link asks for the folder's password. Manage the link itself from the folder.

[Private and restricted](/docs/files/private-files) files and folders can't have links. If something inside a shared folder is restricted later, it drops out of the share.

## Revoke a public link

1. In the **Share** tab, select **Revoke**.
2. Select **Confirm revoke**.

The link stops working immediately, including for anyone who already entered the password. Visitors see "This link is no longer available." To share again, create a new link: it will have a different address.

## What visitors see

![A shared folder as a visitor sees it, with a read-only file tree and the folder's README as its front page](/docs/images/public-share.webp)

- **A file link** shows the one document, rendered the same way it is in the workspace.
- **A folder link** shows a read-only file tree with **Search files…**, and the folder's [front page](/docs/files/folder-pages) or calendar view if it has one. Relative links between files in the folder work.
- A password-protected link first shows **Password required**. Visitors enter it and select **Unlock**. A wrong password shows "Incorrect password".
- Images show inline, and video and audio play in the page, including on password-protected links. PDFs and other files can be downloaded.
- Visitors can't edit, comment, see comments, see history or view a file's source.
- The page uses the workspace's own [theme](/docs/sharing/customise-your-workspace), with **Shared with Treehouse** and a **Create your own workspace** link in the corner.

A pinned link keeps serving its version. If that version is ever unavailable, the visitor is told so rather than shown a different one.

## Limits

On Seedling, public links in a workspace can be opened **500 times a month**. A view is one visitor opening one link on one day, however many files they look at. Bots and link previews (Slack, iMessage and the like) aren't counted, and neither are members opening member links. There's also a cap on how much data public links can serve.

When a workspace reaches its limit, its public links pause until the next month. Visitors see "This link is temporarily unavailable." and "Please check back shortly.", with no mention of plans. The workspace owner is emailed as the limit gets close and again when links pause. Upgrading brings every link back immediately.

Grove and Forest have no limit on share views. You can see this month's count under **Share views** in the workspace's details panel. See [plans and limits](/docs/account/plans-and-limits).

## Troubleshooting

### Why won't my public link create?

If the file or folder is private, or sits inside a private folder, Treehouse refuses to share it. Private items can only be seen by their owner. If you want it public, make it no longer private first ([private files](/docs/files/private-files) explains how).

### Why can't my agent create a public link?

By design. Agents and API keys can only create member links. Ask a person to create the public link in the web app.