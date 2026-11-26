---
title: "Self-hosted Obsidian sync: every real option, compared"
seoTitle: "Self-hosted Obsidian sync: 8 options for teams and agents | Treehouse"
description: There is no self-hosted Obsidian Sync server. Here are the real options, from Treehouse, hosted or self-hosted, to LiveSync and Git, compared for teams.
kind: guide
eyebrow: Guide
cardTitle: Self-hosted Obsidian sync
position: 5
lastChecked: 2026-11-26
summary:
  - You can't self-host Obsidian Sync itself. Obsidian's help says it has no on-premises version, so "self-hosted Obsidian sync" always means a different tool moving the same vault folder.
  - For a team and its AI agents sharing one vault, Treehouse is built for the job. Everyone keeps Obsidian, every change carries the name of the person or agent who made it, and one agent's work comes back in one step. Use the hosted service with nothing to run, or run the same open source code on your own server.
  - For one person who mainly wants their phone in step, Self-hosted LiveSync or a paid Obsidian Sync plan fits better. Treehouse has no mobile app.
cta:
  heading: One vault for your team and its agents
  body: Keep Obsidian. Sync the vault folder to a workspace, invite your team, and give each agent its own key.
  label: Share your vault
  note: Free for one person. Inviting teammates needs Grove, at $12 a member a month, or $10 billed yearly. Self-hosting is free under the AGPL.
endCta:
  heading: Try it hosted, or run it yourself
  body: The hosted service runs the same open source code. Start there in a few minutes, or follow the self-hosting docs and point your vault at your own server.
  label: Share your vault
  note: Free for one person. Inviting teammates needs Grove, at $12 a member a month, or $10 billed yearly. Self-hosting is free under the AGPL.
faq:
  - question: Can you self-host Obsidian Sync?
    answer: No. Obsidian's help says Obsidian Sync "does not have an on-premises solution at this time". The feature request for a self-hosted server has been open since 16 July 2021. What you can self-host is a different sync tool for the same vault folder, such as Self-hosted LiveSync, a Git server, Syncthing or Treehouse.
  - question: What is the best self-hosted Obsidian sync?
    answer: It depends who is syncing. For a team, and especially a team with AI agents in the vault, Treehouse, hosted or on your own server, as long as the people who sync use Apple silicon Macs. For one person across a computer and a phone, Self-hosted LiveSync. For a technical team that already works in Git, Obsidian Git on a Git server you run.
  - question: Is Obsidian open source?
    answer: No. Obsidian is free to use, including at work, but its terms say the software is licensed, not sold, and forbid reverse engineering it. Your notes are plain Markdown files in a folder, so open source tools can sync and read them. Self-hosted LiveSync, Obsidian Git, Syncthing and Treehouse are all open source.
  - question: Does Obsidian Git sync work on a phone?
    answer: Poorly, by its own account. The Obsidian Git README calls the plugin "highly unstable" on mobile and says "I would not recommend using this plugin on mobile". It suggests a separate app called GitSync, and Obsidian's help mentions Working Copy on iOS.
  - question: Does Syncthing still work for Obsidian on Android?
    answer: Yes, through a community app. The official Syncthing Android app was archived on 3 December 2024. Syncthing-Fork continues it, now at researchxxl/syncthing-android, and released v2.1.7.1 on 24 November 2026. Guides that send you to the old app are out of date.
  - question: Can I self-host Treehouse?
    answer: Yes. The code is public under AGPL-3.0-only, and the hosted service runs the same code. You run an API, a background worker with Redis, PostgreSQL, file storage and the web app. There is no one-command install yet, so expect real setup work, not five minutes. If you don't need the server on your own hardware, the hosted service runs the same code and works the same way with Obsidian, with nothing to set up.
  - question: How do AI agents work in a shared Obsidian vault?
    answer: An agent such as Claude Code reads and writes the vault folder as ordinary files, with no plugin. In a shared vault the hard part is telling the agent's edits from a person's. Obsidian's Headless Sync signs in as a person. Git gives an agent its own commit author. Treehouse gives each agent its own key, shows its changes under that name, and can undo them in one step.
sources:
  - label: Obsidian Sync for teams (no on-premises version)
    url: https://obsidian.md/help/teams/sync
  - label: "Feature request: Obsidian Sync self-hosted server"
    url: https://forum.obsidian.md/t/obsidian-sync-self-hosted-server/20975
  - label: Obsidian Sync
    url: https://obsidian.md/sync
  - label: Collaborate on a shared vault
    url: https://obsidian.md/help/sync/collaborate
  - label: Obsidian Sync FAQ
    url: https://obsidian.md/help/sync/faq
  - label: Switch to Obsidian Sync
    url: https://obsidian.md/help/sync/switch
  - label: Obsidian Sync security and privacy
    url: https://obsidian.md/help/sync/security
  - label: Obsidian Sync troubleshooting (conflicts)
    url: https://obsidian.md/help/sync/troubleshoot
  - label: Headless Sync
    url: https://obsidian.md/help/sync/headless
  - label: Obsidian Headless
    url: https://obsidian.md/help/headless
  - label: Sync your notes across devices
    url: https://obsidian.md/help/sync-notes
  - label: How Obsidian stores data
    url: https://obsidian.md/help/data-storage
  - label: Obsidian terms of service
    url: https://obsidian.md/terms
  - label: Obsidian licence overview
    url: https://obsidian.md/license
  - label: Obsidian community plugin statistics
    url: https://github.com/obsidianmd/obsidian-releases
  - label: Self-hosted LiveSync
    url: https://github.com/vrtmrz/obsidian-livesync
  - label: Self-hosted LiveSync, setting up your own server
    url: https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/setup_own_server.md
  - label: Self-hosted LiveSync, conflict resolution
    url: https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/specs_conflict_resolution.md
  - label: Obsidian Git
    url: https://github.com/Vinzent03/obsidian-git
  - label: Obsidian Git tips and tricks
    url: https://publish.obsidian.md/git-doc/Tips-and-Tricks
  - label: Syncthing
    url: https://github.com/syncthing/syncthing
  - label: Syncthing, conflicting changes
    url: https://docs.syncthing.net/users/syncing.html
  - label: Syncthing folder types
    url: https://docs.syncthing.net/users/foldertypes.html
  - label: Syncthing community apps
    url: https://docs.syncthing.net/users/contrib.html
  - label: Syncthing Android (archived)
    url: https://github.com/syncthing/syncthing-android
  - label: Syncthing-Fork for Android
    url: https://github.com/researchxxl/syncthing-android
  - label: Möbius Sync FAQ
    url: https://mobiussync.com/faq/
  - label: Remotely Save
    url: https://github.com/remotely-save/remotely-save
  - label: Relay
    url: https://github.com/No-Instructions/Relay
  - label: Relay pricing
    url: https://relay.md/pricing
  - label: Fast Note Sync plugin
    url: https://github.com/haierkeys/obsidian-fast-note-sync
  - label: Fast Note Sync server
    url: https://github.com/haierkeys/fast-note-sync-service
  - label: Logseq
    url: https://github.com/logseq/logseq
  - label: SiYuan
    url: https://github.com/siyuan-note/siyuan
  - label: Joplin
    url: https://github.com/laurent22/joplin
  - label: Anytype licence
    url: https://github.com/anyproto/anytype-ts/blob/main/LICENSE.md
  - label: Treehouse source code
    url: https://github.com/pixelhop/treehouse
---

## Can you self-host Obsidian Sync?

No. Obsidian's help page for teams says: "Obsidian Sync does not have an on-premises solution at this time." The forum thread asking for one was opened on 16 July 2021 and is still open, with 66 posts.

What you can do is leave Obsidian Sync off and move the vault with something else. A vault is a folder of Markdown files, so anything that syncs a folder can sync a vault. Obsidian documents this itself. The one rule: pick one sync tool per vault. Obsidian's help says using a third-party service alongside Obsidian Sync "can lead to conflicts, resulting in duplicate or corrupted files", and LiveSync's README says the same about running it beside another sync tool.

Everything below was checked on 26 November 2026 against each project's own site, docs or repository.

If you're here because a team, or a team and its AI agents, needs to share one vault, [skip to Treehouse](#treehouse-one-vault-for-your-team-and-its-agents). It works hosted, with nothing to run, or on a server you run yourself.

## Self-hosted Obsidian sync options at a glance

| Option               | What you run                                          | Phones                        | Several people                       | Agents                               |
| -------------------- | ----------------------------------------------------- | ----------------------------- | ------------------------------------ | ------------------------------------ |
| Treehouse            | Nothing on the hosted service, or five parts yourself | No app. Web app in a browser. | Members, with every change named     | Own key each, MCP, one-step undo     |
| Obsidian Sync        | Nothing. Obsidian hosts it.                           | Yes, official apps            | Shared vault, up to 20, each paying  | Headless Sync, signed in as a person |
| Self-hosted LiveSync | CouchDB, or a bucket                                  | Yes, needs HTTPS              | Docs describe devices, not people    | The folder on a synced device        |
| Obsidian Git         | A Git remote, yours or hosted                         | "Highly unstable"             | Commit authors, hand-resolved merges | Good, if the agent commits as itself |
| Syncthing            | No server. One always-on device helps.                | Android fork, third-party iOS | Device IDs, no accounts              | The folder, with no identity         |
| Remotely Save        | A bucket or WebDAV account                            | Yes                           | Shared credentials                   | The folder, with no identity         |
| Relay                | Its server, plus the makers' login                    | We didn't check               | Live co-editing, free for 3 users    | "API access" on the $18 tier         |
| Fast Note Sync       | Its own server                                        | Yes, per its README           | Admin creates users                  | Built-in MCP support                 |

## Which Obsidian Sync alternative fits you

- **A team, or a team plus its agents, on Apple silicon Macs.** Treehouse. Start on the hosted service in a few minutes, or run it on your own server. Either way the vault stays a folder of Markdown files that Obsidian opens as normal.
- **One person, a computer and a phone, no server wanted.** Pay for Obsidian Sync. It's $4 a month billed yearly, end-to-end encrypted, and has nothing to maintain.
- **One person who wants to host it.** Self-hosted LiveSync. It's the most active self-hosted project and it works on phones.
- **Desktop only, and you like Git.** Obsidian Git, on GitHub or a Git server you run.
- **A team that all use Obsidian, with no agents and no outside readers.** A shared vault in Obsidian Sync, or Relay if you want to type in the same note at once.

## What changes when a team and its agents share a vault

Most guides to self-hosted Obsidian sync are about one person's devices. Sharing one vault between people, and then agents, raises three questions those guides skip.

**Who changed this?** LiveSync, Syncthing and Remotely Save know about devices or shared credentials. Obsidian Sync shows who last edited a file, on desktop. Git and Treehouse record a name on every change.

**Whose settings are these?** The `.obsidian` folder syncs with the vault unless you stop it. Its `workspace.json` records one person's open tabs, and plugin settings can hold API keys. With Git, ignore them (see [Obsidian Git sync](#obsidian-git-sync) below). With Treehouse, the layout files stay on each computer from version 0.1.11, and the rest of `.obsidian` is shared. The [Obsidian comparison](/compare/obsidian#what-to-plan-for-with-more-than-one-person) has what we found when we tested it.

**How do you take back what an agent did?** An agent can rewrite forty notes in a minute. File-by-file version history is slow for that. Git handles it if the agent commits separately. Treehouse handles it by key, as the next section shows.

## Treehouse: one vault for your team and its agents

Treehouse is a shared workspace of plain files. People get it as a synced folder and a web app, and agents get an MCP server and a REST API. You keep Obsidian: it opens the synced folder as a normal vault. The code is public under AGPL-3.0-only, and the hosted service runs that same code. So choosing where it runs doesn't mean choosing a different product, and either way your vault is a folder of files on your own computer.

### 1. Choose hosted or your own server

**Hosted** is the quickest way in. [Create a free workspace](/docs/get-started/quickstart) and there's no server to install or keep running. Files are encrypted at rest, and it's the same code you'd run yourself. Seedling is free for one person with as many agents as you like. Inviting teammates needs Grove, at $12 a member a month.

**Self-hosted** suits a team that needs the vault on infrastructure it controls. It means running several parts, and there is no one-command install yet:

| Part         | What it is                                         |
| ------------ | -------------------------------------------------- |
| API          | Sign-in, the file service, the REST API and MCP    |
| Worker       | Background jobs, with Redis as its queue           |
| Database     | PostgreSQL                                         |
| File storage | Cloudflare R2, or a local disk                     |
| Web app      | Builds for Cloudflare Workers, or as a Node server |

One Docker image runs the API and the worker on any container host. Files are encrypted at rest with a key you hold, and if you lose that key the files are gone, so back it up first. Billing is off unless you set it up, so your own server has no plan limits. The setup the Treehouse team documents step by step is Cloudflare plus Railway. [Self-host Treehouse](/docs/self-hosting) has every variable.

Everything after this step is the same either way.

### 2. Connect the vault folder

Turn off Obsidian Sync for this vault first. Then install the sync CLI on an Apple silicon Mac and connect the vault:

```bash
curl -fsSL https://dl.trytree.house/install.sh | sh

# On the hosted service
treehouse login ~/Vaults/Acme

# Or on your own server
treehouse login ~/Vaults/Acme --api-base https://api.example.com
```

Your browser opens, you pick a workspace and approve, and the folder starts syncing. On the hosted service, leave off `--api-base`. The [desktop app](/docs/desktop/install-the-desktop-app) does the same without a terminal: sign in, or enter your own server's app URL and confirm you trust it.

::demo-video{src="/guides/media/sync-to-your-own-server.mp4" poster="/guides/media/sync-to-your-own-server.webp" caption="A vault folder connects to a self-hosted Treehouse server on the same laptop, pulls 56 files, then pushes one edited note. Hosted works the same, without --api-base."}
::

### 3. Invite the team

[Invite people](/docs/sharing/invite-people) with a link. Each person syncs the workspace to a folder and opens it in Obsidian, or uses the web app in a browser with nothing installed. Changes reach everyone within seconds. Two edits to the same note don't merge: the second is kept beside the first as a [conflicted copy](/docs/files/conflicted-copies), so nothing is lost and someone merges by hand.

### 4. Give each agent its own key

An agent working in your synced folder is fast, but its edits show as yours. To give it a name, create a key for it in the web app (account menu, **Agents & API keys**) and connect it over MCP. On your own server, use your API's address in place of `api.trytree.house`:

```bash
claude mcp add --transport http treehouse https://api.trytree.house/api/mcp \
  --header "x-api-key: <your key>"
```

Its changes then appear in [Activity](/docs/sharing/activity) as yours via that key, apart from everyone else's.

![The Activity page lists every change by day and shows which came from a person and which from an agent.](/docs/images/activity.webp)

When an agent gets it wrong, open Activity, hover over its first bad change and select **Undo claude-code's changes…** (with your key's name). Select **Preview changes**, check the list, then **Undo changes**. Everything that key changed since that moment goes back. Files a teammate edited afterwards are left alone and listed. [Undo what an agent did](/docs/files/undo-an-agent) covers the edges.

::demo-video{src="/guides/media/undo-an-agent.mp4" poster="/guides/media/undo-an-agent.webp" caption="An agent key called claude-code made three changes. One undo previews them and takes all three back."}
::

The same workspace gives you [comments](/docs/sharing/comments) that agents can read and answer, and [share links](/docs/sharing/share-links) so a client can read a note in a browser without Obsidian or an account. [Obsidian and Claude Code for teams](/guides/obsidian-and-claude-code-for-teams) walks through the daily routine.

## The other options in detail

Treehouse is one answer. Here is how the rest compare, checked against each project's own docs.

### Obsidian Sync, shared vaults and Headless

Obsidian Sync is the baseline, so it's worth knowing exactly what it does for a team. A shared vault holds at most 20 people, and "all collaborators must have an active Sync subscription". Standard is $4 a user a month billed yearly, or $5 monthly. Plus is $8 or $10. There are no roles yet: Obsidian's help says everyone gets the same permissions as the owner, except that only the owner can invite. There's no live co-editing either, though Obsidian Sync merges Markdown edits for you.

For agents, Obsidian shipped Obsidian Headless, in open beta. It's a command-line client (`npm install -g obsidian-headless`, then `ob sync --continuous`) and Obsidian's help pitches it for giving "agentic tools access to a vault without access to your full computer". It needs an active Sync subscription and signs in with a person's Obsidian account, so an agent's changes arrive under that account. The [Obsidian comparison](/compare/obsidian) covers prices for a team of five and what Obsidian Sync does better.

### Self-hosted LiveSync

LiveSync is a community plugin (MIT, 13,000 stars, version 1.0.52 released on 22 November 2026) that syncs through a database you run. Its README lists four backends:

- **CouchDB on your own hardware.** Real-time. You maintain it, and "for mobile devices, Obsidian requires HTTPS with a valid certificate", so plan for a reverse proxy or a Cloudflare Tunnel.
- **CouchDB on Fly.io.** Real-time, about $2.34 a month in the README's example. It's self-deployed on someone else's cloud, which is not quite the same as self-hosted.
- **Object storage** (S3, R2, MinIO). Syncs periodically or on save, not in real time.
- **Peer-to-peer over WebRTC.** Needs both devices online, and a signalling relay.

It's end-to-end encrypted with a passphrase, keeps revision history, and merges simple conflicts. Setup is: run CouchDB, run the project's init script, put HTTPS in front of it, install the plugin, then copy a "Setup URI" to each other device.

For a team, read the docs closely. They describe syncing devices. We found no section on separate accounts or permissions for several people, and every device joins with a Setup URI carrying the same database credentials and passphrase. That's fine for a household. It gives a team no record of who changed what.

### Obsidian Git sync

Obsidian Git is the most downloaded sync-related plugin, at 3.5 million downloads, and released version 2.44.0 on 23 November 2026. It commits, pulls and pushes on a schedule, pulls on startup, and adds source control, history and diff views. The remote can be GitHub, GitLab or a server you run, which makes it the easiest thing here to truly self-host: a Git server is one small service.

Before a team shares a vault through Git, add this, from the plugin's own docs:

```text [.gitignore]
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/plugins
.trash/
```

The first two lines are Obsidian's layout files, which change every time someone opens a note. The third is there, in the docs' words, "to prevent some plugin from exposing sensitive data".

Git's strengths are real. Each person commits under their own name, an agent can commit under its own, and `git revert` takes back exactly one commit. Its costs are real too. Conflicts are resolved by hand in the editor. Everyone on the team has to be comfortable with Git, which rules out most clients and plenty of colleagues. And the README is blunt about phones: "I would not recommend using this plugin on mobile."

### Syncthing

Syncthing (MPL-2.0, version 2.1.7 released on 21 October 2026) syncs folders directly between devices, with no server. Obsidian's help notes it "works best when at least one device is always on".

Three things older guides get wrong:

- **Android.** The official app was archived on 3 December 2024. The community's Syncthing-Fork continues it, at `researchxxl/syncthing-android`.
- **iOS.** There's no official app. Möbius Sync and Synctrain are third-party apps, and Obsidian lists Syncthing among its unsupported options on iPhone and iPad. Möbius Sync's FAQ says "no iOS app can run continuously in the background".
- **Conflicts.** There's no merge. When two devices change a file, the older one is renamed to a `.sync-conflict` copy.

Syncthing has no user accounts. Folders are shared between device IDs, and its folder types make a device send-only or receive-only, not a person. For a team that means no names on changes.

### Remotely Save, Relay and Fast Note Sync

**Remotely Save** syncs a vault to a bucket (S3, R2, MinIO) or a WebDAV account such as Nextcloud, on a schedule. It has 2.4 million downloads, but its last release was on 20 October 2024 and its last commit on 10 November 2024. A team would share one set of bucket credentials. Check its activity before you build on it.

**Relay** adds live co-editing with cursors to shared folders. The plugin and its relay server are MIT licensed and you can host the server, but its README is clear that "your users will still perform login and permissions checks through our control plane", which is proprietary. It's free for up to 3 users.

**Fast Note Sync** is the closest existing project to a self-hosted vault for people and agents. Its server (Apache-2.0, version 3.6.1 from 14 August 2026) installs with Docker or a script, has an admin screen to create users, note history, share links, and what its README calls "Native MCP (Model Context Protocol) Support". End-to-end encryption is on its roadmap, not shipped. If you want one server that Obsidian talks to through a plugin, look at it.

## Is there an open source alternative to Obsidian?

Obsidian itself is not open source. It's free, including for work, but its terms say you may not "disassemble, reverse engineer or decompile" it. There are two ways to respond to that.

**Keep Obsidian and make everything around it open.** Your notes are already plain Markdown in a folder you own. LiveSync (MIT), Obsidian Git (MIT), Syncthing (MPL-2.0) and Treehouse (AGPL-3.0) all move that folder with open source code. This is the smaller change, and it's what most people searching for this want.

**Replace the app.** Logseq, SiYuan and Trilium are AGPL-3.0. Joplin's apps are AGPL-3.0-or-later, while Joplin Server has its own personal use licence. Anytype is often listed as open source, but its "Any Source Available License" is not an open source licence. If what you want is closer to a team wiki than a notes app, see [open source Notion alternatives](/guides/open-source-notion-alternatives).

## When Treehouse is the wrong choice

- **You mainly want your notes on your phone.** Treehouse has no mobile app. Use LiveSync or Obsidian Sync.
- **Your team is on Windows or Linux.** Sync runs on Apple silicon Macs only today. Windows and Linux are coming, and Intel Macs aren't supported. Everyone else gets the web app, not a vault.
- **You want end-to-end encryption.** Obsidian Sync and LiveSync have it. Treehouse encrypts files at rest, with a key the server holds.
- **You want the smallest thing to host.** A Git server or one CouchDB container is far less to run than five parts.
- **You're one person with no agents.** Attribution and undo by key solve a problem you don't have.
- **You want two cursors in one note.** That's Relay.

## What doesn't work yet

- **No one-command install.** There's no Docker Compose file for the whole stack. You wire the parts together from the docs.
- **Only R2 and local disk are tested** for file storage. Another S3-compatible store may work.
- **Edits don't merge.** Stale writes become conflicted copies. Obsidian Sync and LiveSync merge Markdown for you.
- **Embeds and hidden comments.** In the web app, `![[embeds]]` show as links and `%%comments%%` are visible. Both are fine inside Obsidian.
- **Renames on disk don't update links** in other notes. Renames in the web app or over MCP do, and Obsidian's own rename setting covers renames made there.
- **The web app's file list doesn't update live.** Open a file or reload to see what others changed.