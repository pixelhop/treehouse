---
title: Publish an HTML page
navTitle: HTML pages
description: Show HTML files as full pages, decide when their scripts may run, and share them publicly as reports, dashboards or decks.
type: how-to
position: 8
updated: 2026-09-29
related:
  - /docs/sharing/share-links
  - /docs/files/folder-pages
  - /docs/files/view-files
---

Any `.html` or `.htm` file in a workspace is shown as a page, filling the whole area to the right of the sidebar. That makes HTML a good format for things agents build for people to look at: a weekly report, a dashboard, a set of slides. The agent writes one file, and it's readable in the app and shareable by link.

Pages are shown in a sandbox, sealed off from the app and your account. By default no scripts run, links work, and forms are switched off. Switch to **Source** in the top bar to see the HTML itself.

## Let a page run its scripts

Some pages need JavaScript to work at all: a deck whose arrow keys move between slides, or a chart that draws itself. When a page has scripts, Treehouse asks before running them.

1. Open the HTML file. A notice appears in the corner: "This page wants to run JavaScript." and "It runs sealed off from your session and workspace."
2. Select **Allow** to run the scripts, or **Not now** to keep the page inert.

Your answer is remembered for that exact content, in this browser, for your account only. If the file changes, you're asked again with "This page has changed since you let it run." and **Allow again**. Each person in the workspace decides for themselves.

To change your mind later, select **⋯** in the top bar, then **Run scripts** or **Stop scripts**.

::callout{type="warning"}
A page running its scripts can reach the internet, so it could send its own contents somewhere. It can't reach your session, your workspace or the app around it. Only allow pages you trust, especially ones an agent wrote from outside material.
::

## Share a page publicly

1. Open the HTML file and select **Show details**.
2. Open the **Share** tab and, beside **Anyone with the link**, select **Create link**.
3. To make an interactive page work for visitors, tick **Let the page run its scripts**.
4. Under **Link target**, choose the pinned option (such as **Pinned to v3**) to share exactly the version you've looked at, or **Live (always latest)** to follow the file as it changes.
5. Select **Create and copy link**. The link is copied to your clipboard.

A live link that runs scripts runs whatever the file becomes, and visitors aren't asked again. The app warns you: "A live link runs whatever this file becomes. Pin it to keep the version you have seen." For anything going to a client, pin it.

Scripts can only be allowed on links to a single HTML file, not on folder links. [Share a file with a link](/docs/sharing/share-links) covers passwords, revoking and the rest.

## Use an HTML page as a folder's front page

Name the file `index.html` and it becomes the folder's front page, shown full width whenever someone opens the folder (unless the folder also has a `README.md` or `index.md`, which come first). See [turn a folder into a page or calendar](/docs/files/folder-pages).

## Troubleshooting

### Images or styles from other workspace files don't load

Relative links resolve from the page's own folder, so check the path first. If the page is running its scripts, workspace images and files it refers to can't load at all: that's the price of sealing a running page off from your session. Put images inline (as `data:` URLs) or load them from the web, or keep scripts off.

### Links to other files open in a new tab

Links to other workspace files open in place, with scripts on or off. A link opens in a new tab instead if you hold a key such as ⌘ while clicking, or if the page's own scripts take over its clicks. In the desktop app that new tab is your web browser.

### There's no Run scripts option

The page has no scripts to run, or you're in **Source** view or editing.