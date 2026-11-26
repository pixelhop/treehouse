---
title: Open source Notion alternatives, checked against their own licences
seoTitle: "Open source Notion alternatives you can self-host (2026) | Treehouse"
description: We read the LICENSE file, compose file and MCP docs of each open source Notion alternative. Here's what is open, what self-hosting takes, and what agents get.
kind: guide
eyebrow: Guide
cardTitle: Open source Notion alternatives
position: 6
lastChecked: 2026-11-26
summary:
  - For a team that works with AI agents, start with Treehouse. Pages, boards and calendars are plain Markdown files in a shared folder, agents get MCP and a REST API with no paid tier, and every agent's changes are named and can be undone in one step. It's AGPL, and you can use the hosted service or run it yourself.
  - Several popular picks aren't open source by their own licence files. Outline is under the Business Source License, Anytype is source-available, Joplin Server is for personal use only, and AppFlowy's open-source server is archived. Most keep your pages in a database, and several charge for agent access when you self-host.
  - Treehouse has no live co-editing and no Notion-style databases. If your team writes in the same page at once or runs on relations and rollups, Docmost, AFFiNE or Outline fits better, so check their licences first.
cta:
  heading: A shared folder of Markdown, for your team and your agents
  body: Boards and calendars are folders of files. Agents get MCP and an API, and every change has a name on it.
  label: Start a workspace
  note: Free for one person. Inviting teammates needs Grove, at $12 a member a month, or $10 billed yearly. Self-hosting is free under the AGPL.
endCta:
  heading: Try it hosted first, then decide where it runs
  body: The hosted service runs the same open-source code you'd host yourself. Your work stays as files in a folder either way.
  label: Start a workspace
  note: Free for one person. Inviting teammates needs Grove, at $12 a member a month, or $10 billed yearly. Self-hosting is free under the AGPL.
faq:
  - question: What is the best open source Notion alternative?
    answer: It depends on what you used Notion for. For a team wiki with live co-editing under an open-source licence, look at Docmost, AFFiNE or Wiki.js. For documents and boards as plain Markdown files that AI agents can work on, look at Treehouse. Check the licence and the self-hosted limits first, because several well-known picks restrict commercial use or charge for features once you host them yourself.
  - question: Can you self-host Notion?
    answer: No. Notion publishes no app source, and its pricing page lists only Notion-hosted plans. Its help pages describe hosting on Amazon Web Services, with a choice of region on the Enterprise plan. A self-hosted Notion means a different product.
  - question: Is AppFlowy still open source?
    answer: The apps are. AppFlowy's desktop, mobile and web clients are under the AGPL. The open-source server repository, AppFlowy-Cloud, is archived, and its README says the current self-hosted server is a closed-source fork under a commercial licence. The free self-hosted tier is one user seat and up to three guest editors.
  - question: Is Outline open source?
    answer: Not by its own licence. Outline uses the Business Source License 1.1, and the LICENSE file says it "is not an Open Source license". You can read the code and self-host it, but you can't offer it to others as a document service. The licence changes to Apache 2.0 on 15 November 2030.
  - question: Which self-hosted Notion alternatives work with AI agents?
    answer: Most now ship an MCP server, with different limits. Outline's and Wiki.js's work on self-hosted installs. AppFlowy's and Docmost's need a paid licence when self-hosted. AFFiNE's is read-only on stable builds. Anytype's, Logseq's and Joplin's run locally beside the desktop app. Treehouse includes MCP, a REST API and a change feed in the AGPL code, with no licence gate.
  - question: Which Notion alternatives store notes as plain Markdown files?
    answer: Very few. Of the projects we checked, Logseq's older file-based graphs are Markdown or Org files, and Wiki.js 3 can mirror pages into a Git repository through an optional module. The rest keep content in Postgres, SQLite or their own format, and offer Markdown as an export. A Treehouse workspace is Markdown files in a synced folder on your computer.
  - question: Is Treehouse a full replacement for Notion?
    answer: No. Treehouse has no databases with relations, rollups or formulas, and no live co-editing. It covers documents, wikis, boards and calendars as folders of Markdown, with attribution and undo for AI agents. If your team runs on Notion databases, stay on Notion or pick an alternative with databases.
sources:
  - label: Treehouse repository (AGPL-3.0-only)
    url: https://github.com/pixelhop/treehouse
  - label: AppFlowy repository
    url: https://github.com/AppFlowy-IO/AppFlowy
  - label: AppFlowy-Cloud (archived)
    url: https://github.com/AppFlowy-IO/AppFlowy-Cloud
  - label: AppFlowy Self-Hosted Commercial
    url: https://github.com/AppFlowy-IO/AppFlowy-SelfHost-Commercial
  - label: AppFlowy self-hosted Docker Compose and MCP docs
    url: https://github.com/AppFlowy-IO/AppFlowy-SelfHost-Commercial/blob/main/docs/docker-compose.md
  - label: AFFiNE repository and LICENSE
    url: https://github.com/toeverything/AFFiNE
  - label: AFFiNE Enterprise Edition licence
    url: https://github.com/toeverything/AFFiNE/blob/canary/packages/backend/server/LICENSE
  - label: AFFiNE self-host compose file
    url: https://github.com/toeverything/AFFiNE/tree/canary/.docker/selfhost
  - label: AFFiNE MCP provider source
    url: https://github.com/toeverything/AFFiNE/blob/canary/packages/backend/server/src/plugins/copilot/mcp/provider.ts
  - label: AFFiNE MCP
    url: https://affine.pro/mcp
  - label: AFFiNE pricing
    url: https://affine.pro/pricing
  - label: Outline LICENSE (Business Source License 1.1)
    url: https://github.com/outline/outline/blob/main/LICENSE
  - label: Outline hosting requirements
    url: https://docs.getoutline.com/s/hosting/doc/requirements-ULdYnwi4wG
  - label: Outline MCP guide
    url: https://docs.getoutline.com/s/guide/doc/mcp-6j9jtENNKL
  - label: Outline pricing
    url: https://www.getoutline.com/pricing
  - label: Docmost repository
    url: https://github.com/docmost/docmost
  - label: Docmost paid features list
    url: https://github.com/docmost/docmost/blob/main/apps/client/src/ee/licence/components/oss-details.tsx
  - label: Docmost MCP docs
    url: https://docmost.com/docs/user-guide/mcp
  - label: Docmost pricing
    url: https://docmost.com/pricing
  - label: Anytype client licence
    url: https://github.com/anyproto/anytype-ts/blob/develop/LICENSE.md
  - label: Anytype self-host compose
    url: https://github.com/anyproto/any-sync-dockercompose
  - label: Anytype MCP
    url: https://github.com/anyproto/anytype-mcp
  - label: Wiki.js repository and releases
    url: https://github.com/requarks/wiki
  - label: Wiki.js MCP spec
    url: https://github.com/requarks/wiki/blob/scarlett/dev/specs/mcp.md
  - label: SiYuan repository
    url: https://github.com/siyuan-note/siyuan
  - label: SiYuan MCP source
    url: https://github.com/siyuan-note/siyuan/blob/master/kernel/mcp/server.go
  - label: Logseq repository and releases
    url: https://github.com/logseq/logseq
  - label: Logseq CLI docs
    url: https://github.com/logseq/logseq/blob/master/docs/cli/logseq-cli.md
  - label: Joplin LICENSE
    url: https://github.com/laurent22/joplin/blob/dev/LICENSE
  - label: Joplin Server licence
    url: https://github.com/laurent22/joplin/blob/dev/packages/server/LICENSE.md
  - label: Joplin MCP docs
    url: https://github.com/laurent22/joplin/blob/dev/readme/apps/ai_mcp.md
  - label: TriliumNext repository
    url: https://github.com/TriliumNext/Trilium
  - label: Trilium MCP docs
    url: https://github.com/TriliumNext/Trilium/blob/main/docs/User%20Guide/User%20Guide/AI/MCP.md
  - label: Trilium multi-user milestone
    url: https://github.com/TriliumNext/Trilium/issues/4956
  - label: BookStack installation requirements
    url: https://www.bookstackapp.com/docs/admin/installation/
  - label: Focalboard repository
    url: https://github.com/mattermost-community/focalboard
  - label: Plane repository
    url: https://github.com/makeplane/plane
  - label: Huly self-host
    url: https://github.com/hcengineering/huly-selfhost
  - label: Notion pricing
    url: https://www.notion.com/pricing
  - label: Notion data residency
    url: https://www.notion.com/help/data-residency
  - label: Notion API request limits
    url: https://developers.notion.com/reference/request-limits
  - label: Notion MCP
    url: https://developers.notion.com/docs/mcp
  - label: Notion export
    url: https://www.notion.com/help/export-your-content
---

## The open source Notion alternatives, compared

Most lists of open source Notion alternatives were written a year or two ago and repeat each other. We went to each project's own repository, licence file, compose file and docs on 26 November 2026. Licences are quoted as the project states them. Release dates are from GitHub on the same day.

These are the ones a team could run as a shared workspace, with Treehouse, the one we make, first. [Skip to how Treehouse works](#treehouse-plain-files-your-agents-can-use).

| Project   | Licence, as stated                                 | Self-hosting needs                                                             | Where content lives                    | Live co-editing | Agent access when self-hosted                  | Last release              |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------- | --------------- | ---------------------------------------------- | ------------------------- |
| Treehouse | AGPL-3.0-only                                      | Nothing if hosted. Self-hosted: API, worker, Postgres, Redis, storage, web app | Files, in a synced folder on your disk | No              | MCP, REST API and change feed, no licence gate | Public on 23 Nov 2026     |
| AppFlowy  | Apps: AGPL-3.0. Server: closed, commercial licence | Docker Compose, about 14 services                                              | Postgres and S3 storage                | Yes             | MCP, with a paid licence only                  | 0.15.1, 15 Nov 2026       |
| AFFiNE    | MIT (Community), plus an Enterprise licence        | Docker Compose: app, Postgres, Redis                                           | Postgres, as CRDT documents            | Yes             | MCP, read-only on stable builds                | 0.27.4, 18 Aug 2026       |
| Outline   | Business Source License 1.1                        | Postgres, Redis, storage, an SSO provider                                      | Postgres                               | Yes             | Official MCP and REST API                      | 1.13.0, 15 Nov 2026       |
| Docmost   | AGPL-3.0 core, plus an Enterprise licence          | Docker Compose: app, Postgres, Redis                                           | Postgres                               | Yes             | MCP and API keys, with a paid licence only     | 0.98.0, 20 Nov 2026       |
| Anytype   | Any Source Available License 1.0                   | MongoDB, Redis, S3 storage and six sync services                               | Encrypted objects, local-first         | Yes             | Official MCP, local to the desktop app or CLI  | 0.57.9-alpha, 20 Nov 2026 |
| Wiki.js   | AGPL-3.0                                           | The app and PostgreSQL                                                         | Postgres, with an optional Git mirror  | Yes, new in 3.x | Built-in MCP and GraphQL API                   | 3.6.1, 23 Nov 2026        |

These four turn up on the same lists, but they're personal tools more than team workspaces:

| Project     | Licence, as stated                        | Where content lives              | More than one person             | Agent access                        |
| ----------- | ----------------------------------------- | -------------------------------- | -------------------------------- | ----------------------------------- |
| SiYuan      | AGPL-3.0                                  | JSON `.sy` files                 | Its README describes none        | Built-in MCP (admin role), HTTP API |
| Logseq      | AGPL-3.0                                  | Markdown files, or SQLite in 2.0 | Real-time collaboration in alpha | MCP in the desktop app, a CLI       |
| Joplin      | Apps: AGPL-3.0. Server: personal use only | SQLite on each device            | Server is non-commercial only    | Built-in MCP, off by default        |
| TriliumNext | AGPL-3.0                                  | SQLite                           | No. Single-user                  | Built-in MCP, off by default        |

## Three things the usual lists miss

### "Open source" is used loosely

Four well-known picks don't meet the usual meaning of the phrase, by their own licence files:

- **Outline** is under the Business Source License 1.1. Its LICENSE says the BSL "is not an Open Source license". You may not use it to run a document service for third parties. It becomes Apache 2.0 on 15 November 2030.
- **Anytype** is under the Any Source Available License 1.0. Commercial use is allowed only on networks approved by Any Association. Its own README calls it "open code". The sync servers are MIT.
- **Joplin Server** is under a Personal Use License: "personal non-commercial purposes only" unless you have written permission. The Joplin apps are AGPL.
- **AppFlowy** has AGPL apps, but the open-source server repository is archived. Its README says the production server is now "a closed-source fork of this open-source core combined with proprietary features", under the AppFlowy Self-Hosted Commercial License.

AFFiNE and Docmost are open core. AFFiNE's Community Edition is MIT, with an Enterprise licence on part of the backend. Docmost's core is AGPL, with an Enterprise licence on its `ee` folders. Both are open source for what the community edition includes, so check which features that is.

None of this makes them bad software. It matters if your reason for leaving Notion is a licence your company can rely on, or if you plan to offer the tool to clients.

### Your content lives in a database

AppFlowy, AFFiNE, Outline, Docmost and Wiki.js keep pages in Postgres. TriliumNext, Joplin and the new Logseq use SQLite. SiYuan stores JSON `.sy` files, and Anytype stores encrypted objects. Markdown is an export, not the thing itself.

The exceptions are small. Logseq's older file-based graphs are Markdown or Org files, and Wiki.js 3 has an optional Git storage module that commits each page as a file.

That's a fine design for an editor. It decides what else can touch your work, though. A script, a `grep`, a coding agent or a different editor can open a file. They can't open a row in Postgres without going through the app.

### Agent access is often paid, local or read-only

Most of these projects shipped an MCP server in 2026. Self-hosters get very different deals:

| Project     | MCP when you self-host                                                              |
| ----------- | ----------------------------------------------------------------------------------- |
| Treehouse   | Included: MCP, REST API and change feed. Billing is off unless you add Stripe       |
| AppFlowy    | Bundled, but refuses to run without a One, Team or Enterprise licence               |
| Docmost     | Needs a Business or Enterprise licence. API keys are on the paid list too           |
| AFFiNE      | Reads only on stable builds. Write tools are in dev and canary builds. Needs AI on  |
| Outline     | Official, at `<your domain>/mcp`, with OAuth or an API key                          |
| Wiki.js     | Built in, with personal access tokens that carry the user's permissions             |
| Anytype     | Talks to the desktop app on `127.0.0.1`, or to `anytype-cli`. Not a server endpoint |
| Logseq      | Runs in the desktop app                                                             |
| Joplin      | Runs in the desktop app, on the Web Clipper port. Each tool is off by default       |
| TriliumNext | Built in from 0.103.0, off by default. Its docs call the AI features experimental   |
| SiYuan      | Built in at `/mcp`, for the admin role                                              |

A local MCP server suits one person with the app open. A team that wants an agent running on a server, on a schedule, needs an endpoint the agent can reach on its own.

## Treehouse: plain files your agents can use

Treehouse starts from the other end. A workspace is a folder of plain files. People get it as a synced folder and in a web app. Agents get the same files through an MCP server, a REST API and a change feed. The code has been public under AGPL-3.0-only since 23 November 2026, at [github.com/pixelhop/treehouse](https://github.com/pixelhop/treehouse), and the hosted service runs that same code. You can [start on the hosted service](/docs/get-started/quickstart) with nothing to run, free for one person, or [host it yourself](#self-hosting-treehouse). It works the same either way.

What Notion users tend to recognise:

- **Pages and wikis** are Markdown files, with wikilinks, backlinks, tags and a front page for each folder.
- **Boards and calendars** are folders. A [folder page](/docs/files/folder-pages) with `view: board` shows each Markdown file as a card, placed by the `status` in its front matter. `view: calendar` places files by `date`.
- **Review** happens in [comments](/docs/sharing/comments) on selected text, which agents can read and reply to.

::demo-video{src="/guides/media/workspace-tour.mp4" poster="/guides/media/workspace-tour.webp" caption="A workspace in the web app: a front page, a project folder, the Tasks folder as a board and the Meetings folder as a calendar."}
::

The board isn't a database view. It's a folder of files, so anything that reads files can read it. Moving a card changes one line of front matter, whether a person drags it or an agent edits it. [Boards](/docs/files/boards) has the format.

::demo-video{src="/guides/media/board-is-a-folder.mp4" poster="/guides/media/board-is-a-folder.webp" caption="The same Tasks board in a terminal: one Markdown file a card, its status in front matter, and grep listing the cards in Doing."}
::

For agents, the parts that matter are included rather than sold as a tier:

- **Each agent gets its own key.** Its changes show in Activity under that key's name, marked as an agent.
- **One step takes an agent's work back.** Pick a moment, preview the files, and [undo everything that key changed](/docs/files/undo-an-agent) since. Files someone else has edited afterwards are left alone and listed.
- **Hosted or self-hosted, the endpoints are the same.** Agents connect to `https://api.trytree.house/api/mcp`, or to `https://<your-api>/api/mcp` on your own server. See the [MCP server reference](/docs/agents/reference/mcp-server) and the [REST API](/docs/agents/reference/rest-api).

::demo-video{src="/guides/media/undo-an-agent.mp4" poster="/guides/media/undo-an-agent.webp" caption="In Activity, an agent key's three changes are expanded, previewed and undone in one step."}
::

One thing to be exact about: "plain files" describes what you and your agents work with. On the server, file contents sit in blob storage, encrypted at rest, and Postgres keeps the metadata, versions and change feed. Whoever runs the server holds the encryption key: Treehouse on the hosted service, you when you self-host. The plain copy is the synced folder on each person's computer, which stays readable with or without Treehouse.

The [Notion comparison](/compare/notion) has the head-to-head, including measured read speeds and how undo differs. For a team knowledge base that agents keep filed, see [an AI second brain for teams](/guides/ai-second-brain-for-teams).

### Self-hosting Treehouse

You don't have to. The hosted service has nothing to run, and Grove adds teammates at $12 a member a month. If you need it on your own infrastructure:

A deployment has six parts: the API, a background worker, PostgreSQL, Redis, blob storage and the web app. One Dockerfile in the repository builds the image for the API and the worker. Storage is Cloudflare R2 or a local disk. Other S3-compatible stores may work, but only R2 is tested. The setup the team documents is Cloudflare with Railway.

There's no one-command install yet. No compose file brings up the whole stack, so expect to wire the parts together from the [self-hosting docs](/docs/self-hosting). With no Stripe keys set, billing is off and a workspace has no plan limits.

Clients connect to your server by its address. The desktop app takes your app's URL and asks you to confirm you trust it. The CLI takes a flag:

```bash
treehouse login ~/Acme --api-base https://api.example.com
```

::demo-video{src="/guides/media/sync-to-your-own-server.mp4" poster="/guides/media/sync-to-your-own-server.webp" caption="The treehouse CLI connects a folder to a Treehouse server running on the same laptop, pulls 56 files, then pushes an edited note back."}
::

::callout{type="warning"}
Files are encrypted with a master key you set, `BLOB_KEK`. If you lose it, the stored files can't be read again. Back it up before you store anything.
::

## Self-hosted Notion alternatives: what you'd run

First, the short version on Notion itself: there's no self-hosted Notion. Notion publishes no app source, its pricing page lists only Notion-hosted plans, and its help pages describe hosting on Amazon Web Services, with a choice of region on Enterprise. A self-hosted Notion alternative is always a different product.

How much you take on varies a lot:

- **Smallest.** Docmost and AFFiNE each run from a short Docker Compose file: the app, Postgres and Redis. Wiki.js 3 needs the app and PostgreSQL. SiYuan and TriliumNext are a single container each, for one person.
- **Middle.** Outline needs Postgres 14 or newer, Redis, file storage and an external sign-in provider. Its requirements page says it doesn't run on Windows.
- **Largest.** AppFlowy's compose file lists about 14 services, including Postgres, Redis, MinIO, a sign-in service, search, AI and a backup job. Anytype's sync stack has MongoDB, Redis, S3 storage, a coordinator, a file node, three sync nodes and a consensus node.

Then check what the free self-hosted edition includes. AppFlowy's is one user seat and up to three guest editors. AFFiNE's pricing page lists up to 10 members a workspace. Outline's Community Edition is described as "limited features, no support", without guests or SAML. Docmost's leaves out SSO, page-level permissions, API keys and its bases, kanban and calendar views.

Treehouse sits in the middle on effort, as [above](#self-hosting-treehouse), or you can skip running it and use the hosted service.

## Notes on each project

**AppFlowy.** The most-starred project here, with desktop apps for macOS, Windows and Linux and mobile apps for iOS and Android. Self-hosting is no longer open source, and the free self-hosted tier fits one person. If you saw it recommended as "Notion but self-hosted", that advice is older than the server change.

**AFFiNE.** Local-first, with real-time collaboration. The simplest serious stack to run. The last stable release was in August 2026, with daily canary builds since. Agents can read over MCP on stable builds but not write.

**Outline.** A polished team wiki with live co-editing and the most complete agent story of the group: an official MCP server that works on self-hosted installs, plus a REST API. Its pricing page doesn't say whether the free Community Edition includes MCP, so confirm that before you plan around it. Not open source until 2030.

**Docmost.** A wiki with real-time collaboration, diagrams and an AGPL core. A good fit if you want open-source docs and don't need agents. MCP, API keys and AI are paid, at $6 a seat a month billed yearly with a 10-seat minimum.

**Anytype.** Offline-first and encrypted, with shared spaces. Check the licence if your use is commercial. Its MCP server is official and MIT, but it connects through the desktop app or CLI on the same machine.

**Wiki.js.** Version 3.0 went stable on 1 November 2026, after the 2.x line, and reached 3.6.1 within the month. It's AGPL, needs only PostgreSQL, and has a built-in MCP server and an optional Git mirror. It's a wiki, and a very new major version, so test it before you move a team in.

**SiYuan, Logseq, Joplin and TriliumNext.** All four are good tools for one person's notes. If you'd rather keep Obsidian and only change how the vault syncs, see [self-hosted Obsidian sync](/guides/self-hosted-obsidian-sync). TriliumNext is single-user, with multi-user support still an open milestone. Logseq's 2.0 is a beta that moves from files to SQLite, and its README warns that data loss is possible. Joplin's server licence rules out commercial use.

**Also on older lists.** Focalboard's repository says it is "currently not maintained", and its last release was in June 2024. BookStack is MIT and runs on PHP with MySQL or MariaDB. It has a REST API, and we found no official MCP server in its repository. Plane (AGPL) and Huly (EPL-2.0) are project trackers with docs attached, and both run large stacks.

## When Notion is still the better choice

Leaving isn't always right. Stay on Notion if:

- **You run on databases.** Relations, rollups, formulas and many views of one table are Notion's strongest feature. Treehouse has none of it, and we didn't test how far the alternatives' own databases go.
- **People write in the same page at once.** Notion has live co-editing, and so do AppFlowy, AFFiNE, Outline and Docmost. Treehouse doesn't.
- **You want AI built in.** Notion runs its own AI and agents inside the product, on Business and Enterprise. It also hosts an official MCP server at `mcp.notion.com` on every plan.
- **Nobody wants to run servers, and you don't need open source.** Notion is $10 to $12 a seat a month on Plus and $20 to $24 on Business, with nothing to operate. Every self-hosted option above costs someone's time instead. Treehouse's hosted service is the exception if you still want plain files and agent access.
- **Self-hosting isn't a requirement.** If your worry is agents and speed rather than where the data sits, read the [comparison](/compare/notion#where-notion-is-the-better-choice) first.

Notion's export gives you Markdown and CSV, so you can leave later. Its help page says a workspace export can take up to 30 hours and can't be re-uploaded to recreate the workspace.

## What Treehouse doesn't do yet

- **No live co-editing.** Sync carries changes within seconds, and edits are version-checked. If two people change the same file at once, the later one becomes a [conflicted copy](/docs/files/conflicted-copies) to merge by hand. Nothing is overwritten, but it isn't a shared cursor.
- **No databases.** Boards and calendars come from front matter. There are no relations, rollups or formulas.
- **Sync runs on Apple silicon Macs only.** The desktop app and the [CLI](/docs/desktop/sync-with-the-cli) don't run on Windows, Linux or Intel Macs today. Windows and Linux are marked as coming soon. Everyone else uses the web app, which is also the answer on a phone, because there's no mobile app.
- **The web app's file tree doesn't update live.** Open a file or reload to see what others changed.
- **Self-hosting takes assembly.** Six parts, no single install command, and one tested storage provider.
- **No built-in AI.** Treehouse doesn't run agents or call models. You bring Claude Code, Cursor or whatever you use, and it works on the files.

If those are fine for your team, the quickest test is the hosted free plan: one person, 1 GB, as many agents as you like. If your work is a wiki that five people edit together all day, pick Docmost, AFFiNE or Outline, and read the licence first.