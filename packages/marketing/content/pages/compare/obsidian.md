---
title: Keep Obsidian. Add your team and your agents.
seoTitle: "Obsidian for teams: share a vault with people and agents | Treehouse"
description: Treehouse syncs a plain folder, so your vault can be a shared workspace for your team and agents. Here's what works today, what doesn't, and what it costs.
kind: comparison
competitor: Obsidian
eyebrow: Obsidian for teams
cardTitle: Obsidian
position: 1
lastChecked: 2026-10-30
summary:
  - You don't have to leave Obsidian. A vault is a folder of Markdown files, and Treehouse syncs folders, so you keep writing in Obsidian while teammates, clients and agents work on the same files.
  - Sharing takes a few minutes. Connect the vault once and invite people. Agents keep working on local files at disk speed, and their edits reach everyone within seconds.
  - You gain a web app that follows your wikilinks, for people who don't use Obsidian, public links for clients, comments, a feed showing which agent changed what, and a one-step undo for an agent's work.
  - You give up Obsidian Sync, which merges Markdown edits for you and costs less. If your team all use Obsidian and don't need agents or outside readers, a shared vault in Obsidian Sync is the simpler choice.
cta:
  heading: Share your vault with your team
  body: Point Treehouse at your vault folder. Everyone gets the same files, in Obsidian or in a browser.
  label: Share your vault
  note: Free for one person. Inviting teammates needs Grove, at $12 a member a month, or $10 billed yearly.
endCta:
  heading: Bring your vault. Bring your team.
  body: Connect the folder you already have, invite the people who need it, and give each agent its own key.
  label: Share your vault
  note: Free for one person. Inviting teammates needs Grove, at $12 a member a month, or $10 billed yearly.
comparison:
  - label: What it is
    treehouse: A shared workspace of plain files, with a web app, a synced folder, an MCP server and a REST API.
    them: A note-taking app that works on a local folder of Markdown files. Sync and Publish are optional paid add-ons.
  - label: How people get in
    treehouse: Any browser, or a synced folder they open in Obsidian or anything else.
    them: The desktop or mobile app. There is no web app.
  - label: Sharing with the team
    treehouse: Unlimited members on Grove and Forest, with owner, admin and member roles. Seedling is for one person.
    them: Up to 20 people on a shared vault, each with their own paid Sync plan. There are no roles yet, and only the owner can invite.
  - label: Sharing outside the team
    treehouse: Read-only links to a file or folder, with an optional password and a pinned version.
    them: Obsidian Publish, a separate product at $8 a site a month billed yearly, with a site-wide password.
  - label: Two edits to one note
    treehouse: Both are kept, the second as a conflicted copy beside the note. You merge them by hand.
    them: Markdown edits merge by default, and settings files merge too. Most other file types keep the most recent edit, with earlier ones in version history.
  - label: Live co-editing
    treehouse: No.
    them: Not yet. Obsidian says it doesn't support live editing on the same file, and Multiplayer is planned on its roadmap with no date.
  - label: Agents
    treehouse: An MCP server and REST API, or the synced folder. Over MCP, each agent has its own key and shows up under its own name.
    them: An official CLI that needs the app running, and Headless Sync in open beta, which logs in as a person. We found no official MCP server. Community plugins fill the gap.
  - label: Undoing an agent
    treehouse: Reverse everything one key changed since a moment you choose, in one step, keeping everyone else's edits.
    them: Restore earlier versions a file at a time, or bulk-restore deleted notes. We found no way to undo one agent's changes across a vault.
  - label: Links, graph and plugins
    treehouse: Wikilinks and a Linked from panel in the web app. No graph view or embeds there, and plugins only run in Obsidian.
    them: Native wikilinks, backlinks, graph view, Canvas, Bases and thousands of community plugins.
  - label: Offline and mobile
    treehouse: The synced folder is on your disk. On a phone, the web app works in the browser. There's no native app.
    them: Local-first, with free iOS and Android apps.
  - label: Encryption
    treehouse: Files are encrypted at rest, with a key per workspace. Not end-to-end.
    them: Sync is end-to-end encrypted by default. A standard option uses a key Obsidian manages.
faq:
  - question: Can I use Obsidian with Treehouse?
    answer: Yes. A vault is a folder of Markdown files, so you connect that folder with the Treehouse desktop app or sync CLI and keep opening it in Obsidian. The notes on disk stay exactly as you wrote them.
  - question: Can I run Obsidian Sync and Treehouse on the same vault?
    answer: "No. Obsidian's own advice is not to use a third-party sync service alongside Obsidian Sync, so turn Sync off for that vault first. Using a different sync service instead of Obsidian Sync is fine, and Obsidian documents that."
  - question: How do I share an Obsidian vault with my team?
    answer: Either use a shared vault in Obsidian Sync, where each person pays for their own Sync plan and everyone needs the app, or sync the vault to a Treehouse workspace, where teammates can use Obsidian or just a browser. Both work. Treehouse also suits people outside the team and agents.
  - question: Does Obsidian have real-time collaboration?
    answer: Not live co-editing. Sync moves changes between people quickly and merges Markdown, but Obsidian says it doesn't yet support live editing on the same file. Treehouse doesn't have live co-editing either.
  - question: Does Treehouse show wikilinks?
    answer: Yes. Wikilinks and aliases work in the web app, and each note lists what links to it. A link to a heading opens the note but doesn't jump to the heading yet. An embed shows as a link rather than the file, so use a standard Markdown image where you want one seen.
  - question: Can a client read my notes without installing Obsidian?
    answer: Yes. Create a public link to a file or folder and they read it in a browser with no account. Check for hidden comments first, because Treehouse shows them.
sources:
  - label: Obsidian Sync
    url: https://obsidian.md/sync
  - label: Obsidian pricing
    url: https://obsidian.md/pricing
  - label: Sync plans
    url: https://obsidian.md/help/sync/plans
  - label: Collaborate on a shared vault
    url: https://obsidian.md/help/sync/collaborate
  - label: Sync for teams
    url: https://obsidian.md/help/teams/sync
  - label: Sync FAQ
    url: https://obsidian.md/help/sync/faq
  - label: Sync notes across devices
    url: https://obsidian.md/help/sync-notes
  - label: Version history
    url: https://obsidian.md/help/sync/version-history
  - label: Sync security and privacy
    url: https://obsidian.md/help/sync/security
  - label: Sync troubleshooting
    url: https://obsidian.md/help/sync/troubleshoot
  - label: Obsidian Publish
    url: https://obsidian.md/publish
  - label: Obsidian roadmap
    url: https://obsidian.md/roadmap
  - label: How Obsidian stores data
    url: https://obsidian.md/help/data-storage
  - label: Internal links
    url: https://obsidian.md/help/links
---

## What happens when you sync a vault

We tested this on 30 October 2026 with a real vault: opened in Obsidian's desktop app, synced with the Treehouse sync CLI to two separate folders, then checked in the web app, on a public link and over MCP.

| In your vault                    | What we found                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Notes, folders and attachments   | Sync both ways within seconds. Obsidian opens the folder as a normal vault.                                              |
| Properties (front matter)        | Shown as metadata above the note in the web app.                                                                         |
| Wikilinks                        | Work as links in the web app, including aliases, and each note lists what links to it under **Linked from**.             |
| Tags                             | Read from front matter and from the text, including nested tags, and listed on the note. Inline tags aren't highlighted. |
| Embeds, such as `![[image.png]]` | Show as a link, not the file. A standard Markdown image shows as an image.                                               |
| Callouts, highlights and Mermaid | Plain text in the web app.                                                                                               |
| `%%hidden comments%%`            | Visible in the web app and on public links. Only Obsidian hides them.                                                    |
| Canvas and Bases files           | Sync normally. The web app offers them as a download, with no preview.                                                   |
| New, empty notes                 | Don't sync until they have some content.                                                                                 |

::callout{type="warning" title="Check for hidden comments before you share"}
If you keep private asides in `%%comments%%`, a client reading a public link can see them. Move them out of any note you're about to share.
::

## What to plan for with more than one person

**Everyone shares one `.obsidian` folder, apart from the layout.** Settings, themes and plugins sync like any other folder, and you can't exclude your own files yet. That includes each plugin's `data.json`: if a plugin keeps an API key there, everyone in the workspace gets a copy, so check your plugins before you connect the vault.

Obsidian's layout files, `workspace.json` and `workspace-mobile.json`, record one person's open tabs and change every time they move between notes. From version 0.1.11 of the desktop app and CLI, Treehouse leaves them on each person's computer. In our test of that version, two people rewriting the layout every second made no conflicted copies. On older versions, the same thing made five in under a minute, so update before your team joins. You can delete any copies already in `.obsidian`.

**Two edits to one note make a conflicted copy.** The copy appears beside the note in your vault, and nothing is lost, but someone has to merge it by hand. This is where Obsidian Sync is better: it merges Markdown for you.

**Renames depend on where they happen.** An agent's rename over MCP updated the links in other notes in our test, and so does a rename in the web app. A rename on disk doesn't: when we renamed a file in a synced folder by hand, other notes kept the old `[[link]]`. [Treehouse's docs](/docs/files/link-notes) say Obsidian's own rename setting covers renames you make there, and those edits sync as normal. Moving a whole folder doesn't update links either.

**A public folder link only reaches that folder.** Images and wikilinks that point outside it won't work for the reader, so keep a client's images and linked notes inside their folder.

We retested links and tags on the web app on 30 October 2026, using the vault's files. We haven't yet tested renaming notes inside Obsidian while a teammate has the vault open, community plugins from the directory, or Obsidian's mobile apps on a synced vault.

## How to set it up

1. **Turn off Obsidian Sync for this vault**, if you use it. Obsidian advises against running a third-party sync alongside it.
2. **Make a workspace and connect your vault folder**, with the [desktop app](/docs/desktop/install-the-desktop-app) on an Apple silicon Mac or the [sync CLI](/docs/desktop/sync-with-the-cli) anywhere else. A new workspace adds `AGENTS.md` and `README.md` to the folder.
3. **[Invite your team](/docs/sharing/invite-people).** Each person syncs the workspace to a folder and opens it as a vault, or just uses the web app.
4. **[Connect your agents](/docs/agents/connect/how-agents-work)**, each with its own key, so you can see what each one did.

The [Obsidian and Claude Code guide](/guides/obsidian-and-claude-code-for-teams) walks through this for a team using Claude Code.

## Where Obsidian on its own is the better choice

- **Your team all use Obsidian and nobody else needs in.** A shared vault in Obsidian Sync is cheaper, and it merges Markdown for you.
- **You rely on plugins everywhere.** Thousands of community plugins work inside Obsidian. None of them run in the Treehouse web app.
- **You work offline on your phone.** Obsidian has free native apps. Treehouse's web app needs a connection.
- **You want end-to-end encryption.** Obsidian Sync has it by default. Treehouse encrypts files at rest, so it isn't end-to-end.
- **You think in graphs and embeds.** Treehouse follows your wikilinks, but the graph view, embeds, Canvas and Bases are Obsidian's.

## Where Treehouse earns its place

- **Sharing that doesn't need everyone set up.** Connect the vault once and send an invite link. Nobody needs their own Sync plan or the app: teammates can read, edit and comment in a browser, and clients can read a public link with no account.
- **Local speed for agents, shared with the team.** Claude Code keeps working on files on your disk, as it does today, and sync carries its changes to everyone within seconds.
- **Agents as teammates.** Agents connect over MCP with their own key, make partial edits with `edit_file`, and answer review comments. [Activity](/docs/sharing/activity) shows what each one changed.
- **Getting out of trouble.** You can [undo everything one agent did](/docs/files/undo-an-agent), keeping everyone else's work, and preview it first. You can also [restore a folder or the whole workspace to an earlier time](/docs/files/restore-to-an-earlier-time), and bring back deleted files from the [trash](/docs/files/trash).
- **More than notes.** A workspace holds any file type, up to your plan's file size limit, and a folder's `README.md` becomes its front page.

## What it costs

Prices for a team of five, on 30 October 2026, in US dollars:

|                        | Price for five                    | What you get                         |
| ---------------------- | --------------------------------- | ------------------------------------ |
| Obsidian Sync Standard | $25 a month, or $20 billed yearly | 1 GB each, 5 MB largest file         |
| Obsidian Sync Plus     | $50 a month, or $40 billed yearly | 10 GB each, 200 MB largest file      |
| Treehouse Grove        | $60 a month, or $50 billed yearly | 50 GB workspace, 100 MB largest file |

Obsidian costs less. Treehouse costs more because it's doing a different job: a web app, public links and agent access are all included, and agents are never charged as members. If you also want to publish notes from Obsidian, Publish is a separate $8 a site a month billed yearly.