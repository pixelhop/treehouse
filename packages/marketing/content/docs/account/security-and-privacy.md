---
title: Security and privacy
description: How Treehouse encrypts your files, who can see what in a workspace, and how keys, share links and HTML pages are kept in check.
type: concept
position: 4
updated: 2026-10-29
related:
  - /docs/agents/connect/api-keys
  - /docs/sharing/share-links
  - /docs/files/private-files
  - /docs/files/html-pages
---

Treehouse holds your team's working files, often including client work, so it's built to be careful by default. This page explains what protects them and where the limits of that protection are.

## Your files are encrypted at rest

The contents of every file are encrypted before they're stored. Each workspace has its own encryption key, and that key is itself stored encrypted under a master key that's kept in the server's secrets, separately from both the database and file storage. A copy of the database or of the stored files alone can't be read.

Because every workspace has its own key, a problem with one workspace's key doesn't expose any other workspace. Encryption doesn't separate the members of one workspace from each other, though. Within a workspace, what each person can see is decided by permissions, described below.

## Who can see what

- **Members** of a workspace can see and edit all of its files, except other members' [private files](/docs/files/private-files). Your private files are visible only to you, including through your agents and your synced folders.
- **People outside the workspace** can't see anything in it, not even that it exists, unless you give them a [share link](/docs/sharing/share-links).
- **Being in one workspace** gives no access to any other. Each has its own member list.

When someone is [removed from a workspace](/docs/sharing/invite-people#what-happens-when-someone-is-removed), they lose access straight away and the device keys tied to that workspace are deleted.

## Keys and connected agents act as you

Agents reach your workspaces through [connections](/docs/agents/connect/connected-agents) you approve in the browser, or with [API keys](/docs/agents/connect/api-keys). The desktop app and the CLI use keys. Either way, the credential acts as the person who approved or created it: it can see exactly what you can see, and no more.

- **A connected agent** signs in through your browser, never sees your password, and reaches every workspace you belong to. Its changes are always marked as an agent's.
- **An account-wide key** you create under **Agents & API keys** reaches every workspace you belong to.
- **A device key**, created when you connect a synced folder, reaches one workspace only.
- You can disconnect any agent or revoke any key at any time, and it stops working immediately.

Give each agent its own connection or key, so you can tell their changes apart in [Activity](/docs/sharing/activity) and cut one off without affecting the others.

## Share links

Public links are designed to be safe to send:

- Each link has a long, random address that can't be guessed.
- You can add a password.
- Revoking a link takes effect immediately, even for someone who has already entered the password.
- A link pinned to a version keeps showing exactly that version, so what a client sees can't change under them.
- [Private files](/docs/files/private-files) can never be shared publicly.
- Only a person signed in to the web app can create a public link. Agents and API keys can't, however they connect, so a leaked key can't be used to publish your files.

## HTML pages are sandboxed

[HTML files](/docs/files/html-pages) are shown in a sandbox, cut off from the rest of Treehouse, so a page can't read your other files or act as you. Their scripts don't run until someone explicitly allows them: you choose **Allow** for yourself in the workspace, and a public link only runs a page's scripts if whoever created it ticked **Let the page run its scripts**.

## Agents and untrusted content

A workspace can contain text written by anyone who can write to it, including other agents. When Treehouse lists file and folder names for an agent, it marks them as data supplied by users, not instructions to follow. That helps, but no tool can make an agent immune to misleading content. Connect agents to workspaces whose contents you'd trust them to read, and review what they do in [Activity](/docs/sharing/activity).