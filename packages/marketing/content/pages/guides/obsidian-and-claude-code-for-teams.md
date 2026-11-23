---
title: Run Obsidian and Claude Code as a team
seoTitle: "Obsidian and Claude Code for teams: a shared vault guide | Treehouse"
description: Claude Code works well in an Obsidian vault. Doing it as a team is harder. Share the vault, see what Claude changed, and undo it when it goes wrong.
kind: guide
eyebrow: Guide
cardTitle: Obsidian and Claude Code for teams
position: 4
lastChecked: 2026-10-30
summary:
  - Claude Code already works in an Obsidian vault with no plugin, because a vault is a folder of Markdown files.
  - The hard part is the team. On one laptop, Claude's edits are visible to one person and carry no name, and Claude Code's `/rewind` only covers that session's tracked edits.
  - Sync the vault to a shared workspace and give Claude its own key. Everyone sees the same files, every change has a name on it, and you can take back everything Claude did without touching anyone else's work.
cta:
  heading: Give your team one vault, and Claude its own key
  body: Connect your vault folder, invite your team, and see every change Claude makes under its own name.
  label: Share your vault
  note: Free for one person. Inviting teammates needs Grove, at $12 a member a month, or $10 billed yearly.
endCta:
  heading: Make Claude a teammate, not a secret
  body: Share the vault, give Claude a key, and let everyone see what it did. If it goes wrong, undo it in one step.
  label: Share your vault
  note: Free for one person. Inviting teammates needs Grove, at $12 a member a month, or $10 billed yearly.
faq:
  - question: Does Claude Code work with Obsidian?
    answer: Yes. Run Claude Code in your vault folder and it reads and writes your notes as ordinary files. Claude Code doesn't need Obsidian to be open for this.
  - question: Do I need an Obsidian plugin to use Claude Code?
    answer: No. Plugins such as Claudian put Claude Code inside Obsidian's window, which some people like, but Claude Code works on the folder without one.
  - question: Is there an official Obsidian MCP server?
    answer: We found no official one on 30 October 2026. There are community projects, such as the Local REST API plugin with its built-in MCP server, and MCPVault, which works on the vault folder directly.
  - question: How do I share Claude Code's work with my team?
    answer: Put the vault somewhere everyone can reach. Treehouse syncs it to a shared workspace, so Claude's edits reach teammates within seconds, in their own Obsidian or a browser.
  - question: How do I see what Claude Code changed?
    answer: Connect it over MCP with its own key. Its changes then appear in the Treehouse activity feed under that key's name. Edits Claude makes in your synced folder show as yours.
  - question: Can Claude Code undo its own changes?
    answer: Yes, in two ways. Claude Code's `/rewind` restores tracked edits from your session. In Treehouse, Claude can undo changes made with its own key over MCP, and nothing else. Undoing another agent's or a person's work is left to people in the app, so an agent can't be talked into it by something it reads.
sources:
  - label: Claude Code memory (CLAUDE.md and AGENTS.md)
    url: https://code.claude.com/docs/en/memory
  - label: Claude Code checkpointing
    url: https://code.claude.com/docs/en/checkpointing
  - label: Claude Code MCP
    url: https://code.claude.com/docs/en/mcp
  - label: Claude Code skills
    url: https://code.claude.com/docs/en/skills
  - label: Obsidian CLI
    url: https://obsidian.md/cli
  - label: Collaborate on a shared vault
    url: https://obsidian.md/help/sync/collaborate
  - label: Sync FAQ
    url: https://obsidian.md/help/sync/faq
  - label: Sync notes across devices
    url: https://obsidian.md/help/sync-notes
  - label: obsidian-skills
    url: https://github.com/kepano/obsidian-skills
  - label: Local REST API plugin
    url: https://github.com/coddingtonbear/obsidian-local-rest-api
  - label: MCPVault
    url: https://github.com/bitbonsai/mcpvault
  - label: Claudian
    url: https://github.com/YishenTu/claudian
  - label: Claudian Collab
    url: https://github.com/YishenTu/claudian-collab
  - label: Headless Sync
    url: https://obsidian.md/help/sync/headless
---

## Do you need a plugin, a skill or MCP?

Probably not to start. Here's what each route does, so you can pick only what you need.

| Route                           | What it does                           | Obsidian open? |
| ------------------------------- | -------------------------------------- | -------------- |
| Claude Code in the vault folder | Reads and writes notes. Start here.    | No             |
| `obsidian-skills`               | Teaches Claude Obsidian's formats.     | Mostly no      |
| Obsidian's official CLI         | Controls the desktop app.              | Yes            |
| Local REST API plugin           | A local REST API and MCP server.       | Yes            |
| MCPVault                        | A local MCP server on the folder.      | No             |
| Claudian                        | Puts Claude Code in Obsidian's window. | Yes            |
| Treehouse MCP server            | Reaches the shared workspace.          | No             |

`obsidian-skills` is a set of Agent Skills by Steph Ango, Obsidian's CEO, on his personal GitHub. Only its CLI skill needs Obsidian running. Claudian is desktop only.

These connect an agent to the vault's files. Sharing those files takes something else as well, such as Obsidian Sync, Git, Claudian's companion Claudian Collab, or Treehouse, and they differ in how they show who did what and how you get work back.

## Why a one-person setup stops working

- **Claude's work stays on your laptop** until something shares it. Your team can't see it, and can't tell it from yours.
- **Nothing says who did what.** Claude's edits look like yours. Git can tell you, if everyone on the team is happy using Git.
- **Obsidian Sync helps people more than agents.** A shared vault holds up to 20 people, each with a paid Sync plan. Headless Sync can reach it, using a person's Obsidian account. A device name can label its changes in version history, but Claude has no identity of its own.
- **Claude Code's `/rewind` is for one session.** It's a good way back from your own Claude's tracked edits, and Claude Code's docs say to keep using version control for history and collaboration. It doesn't cover a teammate's session.
- **Clients and colleagues without Obsidian are left out.** Publish can show them notes, but it's a separate product with its own subscription.

## 1. Share the vault

Turn off Obsidian Sync for this vault if you use it, because Obsidian advises against running a third-party sync alongside it. Then make a workspace and connect the vault folder with the [desktop app](/docs/desktop/install-the-desktop-app) or the [sync CLI](/docs/desktop/sync-with-the-cli):

```bash
treehouse login ~/Vaults/Acme
```

[Invite your team](/docs/sharing/invite-people). Each person syncs the workspace to a folder and opens it as a vault, or just uses the web app. Claude keeps working on local files at disk speed, exactly as it did before, and sync carries its changes to everyone within seconds. Nobody has to export, push or remember anything. The [Obsidian comparison](/compare/obsidian) lists what we found when we tested a real vault, including what to expect when several people have Obsidian open at once.

## 2. Write down the rules

A new workspace gives you an `AGENTS.md` to edit, and it syncs with the vault, so one set of rules reaches everyone. Current versions of Claude Code read it directly, but only when there's no `CLAUDE.md` in the folder or above it. To be sure, add a `CLAUDE.md` beside it containing one line, `@AGENTS.md`, which imports it. Then add a section for how you use Obsidian:

```markdown [AGENTS.md]
## Working in this vault

- This is a shared Obsidian vault. Other people and agents use it too.
- Never edit anything in `.obsidian/`.
- Use standard Markdown images in anything a client or teammate may
  read in a browser. `![[embeds]]` only show as links there.
- Rename notes with the Treehouse `move_file` tool, which updates links.
  If you rename a file on disk, update every link to it yourself.
- Keep a client's images inside that client's folder.
- Don't delete notes you didn't create. Ask first.
```

[Write your AGENTS.md](/docs/playbooks/write-your-agents-md) has more on what works well here.

## 3. Give Claude its own key

Claude Code can reach the workspace in two ways, and it's worth setting up both:

|               | Synced folder | Over MCP              |
| ------------- | ------------- | --------------------- |
| Best for      | Big edits     | Attribution, comments |
| Changes show  | As yours      | As Claude's           |
| One-step undo | All of it     | Just Claude's work    |
| Sees comments | No            | Yes                   |

Undo works per key, so undoing a synced folder also takes back your own edits from that folder. To see and undo Claude's work on its own, its changes must go through its own key. In the web app, open **API keys**, create a key with **Used by** set to **Agent (MCP)**, then run the command it gives you:

```bash
claude mcp add --transport http treehouse https://api.trytree.house/api/mcp \
  --header "x-api-key: <your key>"
```

Name the key after the job, such as `claude-research`, so it reads well in Activity. Over MCP, Claude makes partial edits with `edit_file` rather than resending whole files, follows links both ways with `get_links`, and finds notes by tag with `list_tags`. The [Claude Code docs page](/docs/agents/connect/claude-code) has the details.

## 4. Review what Claude did

[Activity](/docs/sharing/activity) lists every change and marks which came from a person and which from an agent. To give feedback, select text in a note in the web app and [leave a comment](/docs/sharing/comments), then ask Claude to pick it up:

```text
Read the open comments on Clients/Acme/Brief.md, make the changes,
reply to each thread, and resolve the ones you've fixed.
```

## 5. When Claude gets it wrong

`/rewind` takes back tracked edits in your own session. This is for the shared workspace, whoever's Claude did it, whenever they did it. When Claude rewrites the wrong folder:

1. Open **Activity**, then **See all activity**.
2. Hover over the first change you want gone and select **Undo Claude Code's changes…** (with your key's name).
3. Select **Preview changes**, check the list, then select **Undo changes**.

Everything that key changed after that moment goes back: edits are reversed, deleted files return, renames are put back and new files go to the trash. If a teammate edited one of those files afterwards, Treehouse leaves it alone and tells you, rather than throwing their work away. [Undo what an agent did](/docs/files/undo-an-agent) covers the edges.

Two more safety nets sit behind it. You can [restore a folder or the whole workspace to an earlier time](/docs/files/restore-to-an-earlier-time), and deleted files go to the [trash](/docs/files/trash), where you can bring them back.

Claude can undo its own work too, if you ask it to, with `preview_undo_my_changes` and `undo_my_changes`. It can only ever touch changes made with its own key. Undoing anyone else's work is for people.

## 6. Share the result

When something's ready for a client, [create a public link](/docs/sharing/share-links) to the file or folder. They read it in a browser with no account. Pin the link to a version when you're sending something final, so it keeps saying what it said. Agents can't create public links, by design, so a person always makes that call.

## What doesn't work yet

- **Embeds** show as a link rather than the file, in the web app and on public links, so use a standard Markdown image where you want one seen. Wikilinks work.
- **Hidden `%%comments%%`** are visible in the web app and on public links.
- **Obsidian's layout file** stays on each person's computer from Treehouse 0.1.11. On older versions it makes conflicted copies when two people have the vault open, so update first. See the [Obsidian comparison](/compare/obsidian#what-to-plan-for-with-more-than-one-person).
- **Renames on disk** don't update links in other notes, which is why that rule is in `AGENTS.md`. Renames over MCP and in the web app do.
- **Treehouse doesn't run agents.** It's where the work lives. You bring Claude Code, and you decide when it runs.