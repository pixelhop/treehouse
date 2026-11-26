---
title: Build an AI second brain your whole team can use
seoTitle: "AI second brain for teams: tools, setup and risks (2026) | Treehouse"
description: Most AI second brain advice is for one person. Here's how a team shares one, with agents filing the notes and people able to review and undo their work.
kind: guide
eyebrow: Guide
cardTitle: An AI second brain for your team
position: 7
lastChecked: 2026-11-26
summary:
  - An AI second brain is a set of notes that an AI agent keeps filed, linked and summarised, so you only have to capture. Nearly every app and guide for it assumes one person.
  - A team needs three things those leave out. You need to see who changed a note, take back one agent's work without losing anyone else's, and know what happens when two writers touch the same note.
  - The setup that holds up is a shared folder of plain Markdown files. Agents file and link, people read, review and correct. This guide builds one on Treehouse in seven steps, and says where another tool fits better.
cta:
  heading: Start a second brain your team and its agents share
  body: Make a workspace, connect an agent, and see every change it makes under its own name.
  label: Start a workspace
  note: Free for one person, with as many agents as you like. Inviting teammates needs Grove, at $12 a member a month, or $10 billed yearly.
endCta:
  heading: Let agents do the filing, and keep people in charge
  body: Capture into an Inbox, let an agent file and link it, and review what it did. If it goes wrong, undo it in one step.
  label: Start a workspace
  note: Free for one person, with as many agents as you like. Inviting teammates needs Grove, at $12 a member a month, or $10 billed yearly.
faq:
  - question: What is an AI second brain?
    answer: A second brain is Tiago Forte's name for one trusted place outside your head for notes and the sources they came from. An AI second brain adds an agent that does the upkeep, such as filing, linking and summarising, and answers questions from the notes.
  - question: What is the best second brain app for a team?
    answer: It depends on who does the writing. Notion is the strongest all-in-one app with built-in AI. If you want your own agents, such as Claude Code or Codex, to maintain plain files that the team shares, use a shared folder with attribution and undo, which is what Treehouse is. Most second brain apps, including Capacities and Reflect, are built for one person.
  - question: Does Claude Code share its memory with my team?
    answer: Not by default. Claude Code's docs say auto memory is machine-local and isn't shared across machines or cloud environments. What a team shares is files, such as a `CLAUDE.md` or `AGENTS.md` kept with the work. OpenAI gives the same advice for Codex.
  - question: Is PARA still useful when AI does the organising?
    answer: Yes, as a small set of folders an agent can file into without guessing. Projects, Areas, Resources and Archives give an agent four clear destinations. With an agent adding links as it files, the links end up mattering more than the folders.
  - question: Is it safe to let an AI agent organise my notes?
    answer: It's safe when you can see what the agent did and take it back. Agents have deleted whole note folders and they write summaries that are wrong. Keep originals, give each agent its own name, review its changes, and make sure there's an undo that doesn't depend on the agent.
  - question: What is a personal knowledge management system?
    answer: It's the tools and habits one person uses to gather, classify, store, retrieve and share what they know. A second brain is one popular version of it. The word personal is the limit, because nothing in it says how several people and agents share the same notes.
  - question: Do I need Obsidian to build an AI second brain?
    answer: No. Obsidian is a good editor for a folder of Markdown notes, and many agent setups use it as the viewer. The agent works on the files, not the app, so any folder of Markdown works. If your team already uses Obsidian, you can keep it.
sources:
  - label: "Forte Labs: Building a Second Brain overview"
    url: https://fortelabs.com/blog/basboverview/
  - label: "Forte Labs: the PARA method"
    url: https://fortelabs.com/blog/para/
  - label: "Forte Labs: Introducing the AI Second Brain"
    url: https://fortelabs.com/blog/introducing-the-ai-second-brain/
  - label: "Atlassian: State of Teams 2025"
    url: https://www.atlassian.com/blog/state-of-teams-2025
  - label: Claude Code memory
    url: https://code.claude.com/docs/en/memory
  - label: Claude Code checkpointing
    url: https://code.claude.com/docs/en/checkpointing
  - label: Codex memories
    url: https://learn.chatgpt.com/docs/customization/memories?surface=app
  - label: AGENTS.md
    url: https://agents.md/
  - label: "Andrej Karpathy: LLM Wiki"
    url: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
  - label: claude-obsidian
    url: https://github.com/AgriciDaniel/claude-obsidian
  - label: Mem
    url: https://get.mem.ai/
  - label: Reflect Open announcement
    url: https://reflect.app/blog/reflect-open
  - label: Notion pricing
    url: https://www.notion.com/pricing
  - label: Notion MCP
    url: https://developers.notion.com/docs/mcp
  - label: Obsidian
    url: https://obsidian.md/
  - label: Capacities pricing and FAQ
    url: https://capacities.io/pricing
  - label: Tana
    url: https://tana.inc/
  - label: Khoj
    url: https://khoj.dev/
  - label: Personal knowledge management (Wikipedia)
    url: https://en.wikipedia.org/wiki/Personal_knowledge_management
  - label: "Cursor forum: agent deleted an Obsidian vault"
    url: https://forum.cursor.com/t/agent-ran-destructive-delete-script-on-dev-vault-without-warning/165459
  - label: "Claude Code issue 24196: vaults deleted during a copy"
    url: https://github.com/anthropics/claude-code/issues/24196
  - label: "EBU and BBC: study of AI answers about the news"
    url: https://www.ebu.ch/news/2025/10/ai-s-systemic-distortion-of-news-is-consistent-across-languages-and-territories-international-study-by-public-service-broadcaste
  - label: "Simon Willison: the lethal trifecta"
    url: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
---

## What an AI second brain is

Tiago Forte's Building a Second Brain describes one trusted place outside your head for what you learn and where it came from. His method has four steps, CODE: capture, organize, distill, express. Organizing uses PARA, four folders sorted by how actionable something is: Projects, Areas, Resources and Archives.

The method always had one weak point, which is upkeep. Filing, linking and summarising are dull, so notes pile up unsorted. An AI second brain hands that upkeep to an agent. You capture, the agent files, links and summarises, and you ask the notes questions.

Forte's own framing moved this way in March 2026. He argues that tools like Claude Code and Codex, which read files and take actions, now matter as much as the model, and that your notes and files are about to become your most valuable professional asset.

Search for "AI second brain" and almost everything you find is about one person. Teams have the bigger problem. Atlassian's State of Teams 2025 survey of 12,000 knowledge workers found that teams spend 25% of their time just searching for answers. This guide is about a second brain that several people and several agents write to.

## AI second brain tools in November 2026

Checked on 26 November 2026. Two things matter more than features: whether the tool is built for one person or a team, and where the notes live.

| Tool                   | Built for  | Notes live                    | Worth knowing                                                      |
| ---------------------- | ---------- | ----------------------------- | ------------------------------------------------------------------ |
| Mem                    | One person | Mem's cloud                   | Shuts down 15 January 2027. Read-only from 18 December 2026.       |
| Reflect Open           | One person | Markdown files you choose     | Relaunched 14 July 2026 as an MIT-licensed app. Bring your own AI. |
| Notion                 | Teams      | Notion's cloud                | Notion Agent comes with Business, at $20 a seat a month yearly.    |
| Obsidian with an agent | One person | Markdown files on your device | The "LLM Wiki" pattern. No first-party AI on Obsidian's homepage.  |
| Capacities             | One person | Capacities' cloud             | Its FAQ says there are no team plans.                              |
| Tana                   | Teams      | Tana's cloud                  | Now an agentic meeting platform. Agent edits are proposals.        |
| Khoj                   | One person | Self-hosted or Khoj's cloud   | Open source (AGPL). Chat over your documents.                      |
| Treehouse              | Teams      | Plain files, synced           | No built-in AI. You bring the agents.                              |

Three of those rows are news that most lists haven't caught up with:

- **Mem is closing.** Mem announced on 16 November 2026 that it shuts down on 15 January 2027, with notes read-only from 18 December. It publishes a migration guide. Every Mem user now has to export and move.
- **Reflect went the other way.** Reflect Open is a new open-source app on a folder of Markdown files, synced by iCloud Drive or Git. Reflect's stated reason is that open-source notes can outlive the company. It's a personal app.
- **The "LLM Wiki" pattern.** Andrej Karpathy's gist from April 2026 has an LLM build and maintain an interlinked Markdown wiki, with Obsidian as the viewer and regular "lint" passes for stale claims and orphan pages. Projects such as claude-obsidian (16.8k GitHub stars) build on it. The gist suggests a team version with people reviewing updates. claude-obsidian's own README says its write lock only coordinates writers on one machine.

Notion is the one mainstream team tool here. Notion Agent and Custom Agents are part of the Business plan, Plus has an AI trial only, and a hosted MCP server lets outside agents read and edit pages. Your notes are pages in Notion's cloud, not files. The [Notion comparison](/compare/notion) goes into what that means for agents, and [open source Notion alternatives](/guides/open-source-notion-alternatives) checks the self-hosted options.

## Why a personal second brain stops at one person

The agent makers say it themselves. Claude Code's docs describe its auto memory as machine-local: "Files are not shared across machines or cloud environments." Codex keeps its memories on each machine too, and OpenAI's docs say: "Keep required team guidance in `AGENTS.md` or checked-in documentation."

So what your agent learned on your laptop stays on your laptop. Team knowledge has to live in shared files. Once several people and agents write to those files, three questions come up that personal tools never had to answer:

- **Who changed this note?** On one laptop, an agent's edits look like yours.
- **Can you undo one agent without losing everyone else's work?** Claude Code's `/rewind` covers one session on one machine, and its docs call it "not a replacement for version control".
- **What happens when a person and an agent edit the same note?** One of them usually loses, quietly.

A team second brain is a shared folder of plain files with answers to those three questions. Agents keep it filed and linked. People read, review and correct. The rest of this guide sets that up on Treehouse, which is a shared file workspace: a synced folder and a web app for people, an MCP server for agents, and a record of every change. It's open source under the AGPL, and you can [host it yourself](/docs/self-hosting).

For a personal version of this setup, read [build a second brain](/docs/playbooks/second-brain). If your team's notes already live in Obsidian, read [Obsidian and Claude Code for teams](/guides/obsidian-and-claude-code-for-teams) first.

## 1. Start with a structure based on PARA

PARA works for a team because it gives an agent a small number of clear destinations. Make a workspace and start with this:

```text
AGENTS.md    the rules every agent reads first
Inbox/       everything lands here unsorted
Projects/    work with an end date, one folder each
Areas/       ongoing responsibilities: clients, hiring, finance
Resources/   reference material and reading notes
Archive/     anything retired. Move here, never delete
Meetings/    dated notes, shown as a calendar
```

Rename folders to fit how you talk. An agency might have `Clients/` in place of `Areas/`. Give each folder a `README.md` that says what belongs in it, because the README is both the folder's front page in the web app and the local rules an agent reads.

To show `Meetings/` as a calendar, add `view: calendar` to its README's front matter and give each note a `date`. The notes stay ordinary Markdown files. See [folder pages](/docs/files/folder-pages).

![A Meetings folder shown as a month calendar, with each meeting note on its date](/docs/images/folder-calendar.webp)

## 2. Add an Inbox that an agent files

Capture should take no decisions. Anyone drops a note, a link or a transcript into `Inbox/`, from the synced folder or the web app on a phone. The filing rules live in `Inbox/README.md`, so any agent in any session files the same way:

```markdown [Inbox/README.md]
## How this gets filed

- Notes about a client go in Areas/<client>/Notes/.
- Notes from a conversation go in Meetings/ with a `date:` in the front matter.
- Reading notes go in Resources/ with the source link in the front matter.
- Add a "Related" list of [[wikilinks]] to existing notes on the same topic.
- Never delete anything. Only move.
- If you're not sure, leave it in the Inbox and say so.
```

Then ask an agent:

```text
Process everything in Inbox/ following the rules in Inbox/README.md.
Tell me what you moved and what you left behind.
```

::demo-video{src="/guides/media/agent-files-the-inbox.mp4" poster="/guides/media/agent-files-the-inbox.webp" caption="An agent named inbox-filer moves three Inbox notes into client folders and adds a Related list of links. The note it linked to now lists the new note under Linked from."}
::

The links are the part worth having. Each note shows a **Linked from** list, so a filed note is reachable from the notes it relates to. [Run an inbox your agent files](/docs/playbooks/inbox-and-filing) covers the rules in more depth.

## 3. Write the rules in AGENTS.md

`AGENTS.md` is an open format that Codex, Cursor, Gemini CLI and many other agents read by convention. A new workspace gives you one at the root, and the Treehouse MCP server tells every agent to read it first. Current versions of Claude Code read it when there's no `CLAUDE.md`. To be sure, add a `CLAUDE.md` containing the one line `@AGENTS.md`.

Because the file syncs with the workspace, one set of rules reaches every person's agent. That replaces the per-machine memory a team can't share. Keep it to a page:

```markdown [AGENTS.md]
## Working rules for agents

- This workspace is shared. Other people and agents write here too.
- Never delete files. Move them to Archive/ and say so.
- Keep the original when you summarise. Link the summary to it.
- Don't create top-level folders. Propose them.
- End every task with a list of files you created, changed or moved.
```

When you correct an agent twice, add the rule here. [Write your AGENTS.md](/docs/playbooks/write-your-agents-md) has a full template.

## 4. Give each agent its own name

An agent can reach the workspace through the synced folder or over MCP. Edits in your synced folder show as yours. Edits over MCP show as the agent's, which is what a team needs. Connect Claude Code like this, then run `/mcp` inside Claude Code and sign in through your browser:

```bash
claude mcp add --transport http treehouse https://api.trytree.house/api/mcp
```

Name the connection after its job, such as `inbox-filer`. An agent that runs on a server and can't open a browser gets an [API key](/docs/agents/connect/api-keys) with **Used by** set to **Agent (MCP)**, named the same way. Use one name per agent, not one for the whole team. If you run several, [give each a lane](/docs/playbooks/multiple-agents) in `AGENTS.md` so they work in different folders.

## 5. Review in Activity and comments

[Activity](/docs/sharing/activity) lists every change with a name on it: a person, or an agent shown as the person it belongs to and the name you gave it. After a filing run, read the list. It takes a minute and it's how wrong filings get caught.

To correct an agent's writing, select the text in the web app and [leave a comment](/docs/sharing/comments). Agents connected over MCP can read comment threads, reply and resolve them:

```text
Read the open comments on Areas/Bluebird Bakery/Summary.md, make the
changes, reply to each thread, and resolve the ones you've fixed.
```

![A note with a highlighted passage and a comment thread that an agent has replied to and resolved](/docs/images/comments.webp)

## 6. Undo an agent when it goes wrong

Sooner or later an agent will rewrite the wrong folder. Because every change carries the agent's name, you can take back just its work:

1. Open **Activity**, then **See all activity**.
2. Hover over the first change you want gone and select **Undo inbox-filer's changes…** (with your agent's name).
3. Select **Preview changes**, check the list, then select **Undo changes**.

::demo-video{src="/guides/media/undo-an-agent.mp4" poster="/guides/media/undo-an-agent.webp" caption="In Activity, an agent named claude-code made three changes. Previewing the undo lists the three files, and Undo changes puts them back."}
::

Edits are reversed, deleted files return, moves are put back and files the agent created go to the trash. If a teammate changed one of those files afterwards, Treehouse leaves it alone and lists it. [Undo what an agent did](/docs/files/undo-an-agent) covers the edges. Behind that sit [version history](/docs/files/version-history) for each file and [restoring a folder or the whole workspace to an earlier time](/docs/files/restore-to-an-earlier-time).

Two writers on one note are handled the same way: nobody loses. Every write is checked against the version it was based on. A stale write is saved beside the original as a [conflicted copy](/docs/files/conflicted-copies), and the agent is told.

## 7. Share outward

The last step of CODE is express. When a summary or a brief is ready for someone outside the team, [create a public link](/docs/sharing/share-links). They read it in a browser with no account. Add a password if you need one, and pin the link to a version when you send something final. Agents can't create public links, by design, so a person always decides what leaves the workspace.

## What can go wrong, and what this setup does about it

**An agent deletes your notes.** This has happened. On 11 July 2026 a Cursor user reported that an agent ran a script which recursively deleted their live Obsidian vault. A Claude Code issue from 8 February 2026 describes a copy command that ended in `rm -rf` on the real folder. Both were shell commands on a local folder with no other copy of the personal notes. Treehouse can't stop a command on your laptop. What it changes is what happens next. Deleted files go to the workspace [trash](/docs/files/trash) and can be put back, a folder or the whole workspace can be restored to an earlier time, and if the synced folder itself goes missing, sync stops with an error instead of emptying the workspace. That protects what has synced. It doesn't cover folders outside the workspace.

**An agent writes a summary that's wrong.** Nothing fixes this. An EBU and BBC study in October 2025 found that 45% of AI answers about the news had at least one significant issue. That was news, not notes, but summarising is the same job. The setup limits the damage: originals are kept and linked from the summary, every agent edit is visible in Activity, and each file's earlier versions are there to compare. It still takes a person reading the summary. Treat an agent's summary as a draft until someone has.

**An agent follows instructions hidden in a note.** Simon Willison calls the dangerous mix the "lethal trifecta": access to private data, exposure to untrusted content, and a way to send data out. An agent that reads a shared workspace and can also browse the web has all three. Treehouse narrows a few paths. Agents can't create public links, invite people or manage keys, and an agent can only undo its own changes. You can also [limit a key](/docs/agents/connect/api-keys#limit-what-a-key-can-do) to read only, or to one folder, so an agent that browses the web sees less and can change nothing. It doesn't stop an agent sending what it can read somewhere else with its other tools. Be careful what you paste into the Inbox from outside, and think twice before giving a web-browsing agent the whole workspace.

**The tool goes away.** Mem's users have until January to move. Here the notes are Markdown files in a folder on your disk, and the code is public, so there's nothing to export.

## When Treehouse is not the right choice

- **You're one person and want a polished app with AI built in.** Treehouse has no AI chat of its own. An app with built-in AI fits better: Notion if you like databases and an assistant in the page, Capacities for object-based notes, or Reflect Open or Obsidian if you want plain Markdown on your own device. With Obsidian you can add an agent later.
- **You want the AI included and run for you.** Treehouse doesn't run agents. You bring Claude Code, Codex or another agent, pay for it separately, and decide when it runs. Notion's Business plan includes its agents.
- **You need live co-editing or databases.** Notion has both. The [Notion comparison](/compare/notion#where-notion-is-the-better-choice) is plain about this.
- **Your team works mostly on phones.** There's no mobile app.

## What doesn't work yet

- **Sync is Apple silicon Macs only.** The desktop app and the `treehouse` CLI don't run on Windows, Linux or Intel Macs yet. Windows and Linux are coming. Everyone else uses the web app, and agents connect over MCP from anywhere.
- **No mobile app.** On a phone you use the web app in the browser, which you can add to your home screen.
- **Treehouse doesn't run or schedule agents.** A daily filing run has to come from wherever your agent runs. [Routines](/docs/playbooks/routines) shows how with Claude Code and cron.
- **No built-in AI chat.** Asking your notes a question happens in your agent, not in the web app.
- **No live co-editing.** Changes sync within seconds and a clash becomes a conflicted copy. The web app's file tree doesn't update while you browse, so reload to see others' changes.
- **Agents in a synced folder show as you.** For a named agent you can undo on its own, connect it over MCP.