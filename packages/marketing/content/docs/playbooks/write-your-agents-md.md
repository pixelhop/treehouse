---
title: Write your AGENTS.md
description: The one file every agent reads first. What to put in it so any agent, in any session, works the way your team does.
type: guide
position: 1
updated: 2026-09-30
related:
  - /docs/playbooks/shape-your-workspace
  - /docs/agents/connect/how-agents-work
  - /docs/get-started/set-up-with-an-agent
---

`AGENTS.md` at the root of your workspace is its rulebook. The Treehouse MCP server tells every agent to read it before doing anything else, and coding agents like Claude Code, Codex and Cursor look for it by convention when they open a folder. Whatever you write there, every agent gets, every session, without you repeating yourself.

If an agent [set up your workspace](/docs/get-started/set-up-with-an-agent), it already wrote a first version. This guide is about making it good.

## What belongs in it

A useful `AGENTS.md` answers the questions a new teammate would ask on their first day:

1. **What is this workspace?** One or two sentences. Who it's for and what it's used for.
2. **Where do things go?** The top-level folders and what belongs in each. Keep it to a line per folder; each folder's own `README.md` carries the detail.
3. **How are things named?** File naming, dates, how drafts and final versions are told apart.
4. **What front matter do you use?** The keys your files carry, like `status`, `owner` or `date`, and what the values mean.
5. **What can an agent do on its own, and what needs a person?** Be explicit. "Never delete; move to Archive/." "Ask before creating a top-level folder." "Anything in Clients/ is read by clients, so no internal notes there."
6. **How do you want to hear back?** A summary at the end of a task, a note in a log file, a comment on the document.

Leave out anything an agent can see for itself, like a list of every file. That goes stale the day you write it.

## A template to start from

Copy this into `AGENTS.md` and make it yours. Every line should be true of your workspace; delete the ones that aren't.

```markdown [AGENTS.md]
# AGENTS.md

Acme's product workspace: specs, research, decisions and meeting notes for the
product team (four people) and the agents we work with.

## Where things go

- Inbox/ - anything unsorted. Filing rules are in Inbox/README.md.
- Specs/ - one folder per feature, each with a README.md that tracks its status.
- Research/ - interviews and analysis. Raw notes in Research/raw/.
- Decisions/ - one file per decision, named YYYY-MM-DD-short-title.md.
- Meetings/ - dated notes. Opens as a calendar.
- Roadmap/ - one file per piece of work. Opens as a board; move a card by
  changing its status.
- Archive/ - anything retired. Move things here instead of deleting them.

Every folder has a README.md saying what belongs in it. Read it before adding
files to that folder.

## Conventions

- File names are lowercase with hyphens: pricing-page-copy.md.
- Front matter on every spec and research note:
  - status: draft | review | final
  - owner: the person responsible (first name)
- Dates are always YYYY-MM-DD.

## Working rules for agents

- Never delete files. Move them to Archive/ and say so.
- Don't create new top-level folders. Propose them instead.
- Don't mark anything status: final. Only a person does that.
- When you change a spec, add a line to its "Changelog" section.
- Review comments on a file are the priority when you're asked to "go through
  feedback". Reply to each thread with what you changed.

## When you finish a task

End with a short list of the files you created, changed or moved, and anything
you weren't sure about.
```

## Keep it short and keep it true

- **Aim for a page.** Agents read the whole file every session. A long `AGENTS.md` dilutes the rules that matter, and people stop maintaining it.
- **Push detail down.** Rules about one folder belong in that folder's `README.md`, where the agent reads them when it's working there. `AGENTS.md` points to them.
- **Write rules, not hopes.** "Keep things tidy" gives an agent nothing to act on. "Move anything older than 90 days in Inbox/ to Archive/inbox/" does.
- **Update it when you correct an agent.** If you find yourself telling agents the same thing twice, it belongs in `AGENTS.md`. Ask the agent to add it: "Add a rule to AGENTS.md so you don't do that again."

## Folder READMEs are local rules

Each folder's `README.md` is shown as its [front page](/docs/files/folder-pages) in the web app, so it serves people and agents at once. Use it to say what belongs in the folder, how files in it are named, and any rules that only apply there. For example, `Decisions/README.md`:

```markdown [Decisions/README.md]
---
title: Decisions
view: calendar
---

One file per decision we've made, so we (and our agents) can find out why
things are the way they are.

- Name files YYYY-MM-DD-short-title.md and set `date:` to the same day.
- Use the template in Templates/decision.md.
- Decisions are never edited after the fact. If one is reversed, write a new
  decision that links to the old one.
```

## Check it's working

Start a fresh session with an agent that hasn't seen the workspace and ask it to do an everyday task, like filing a note or drafting a spec. Then ask it: "Which rules in AGENTS.md did you follow, and was anything unclear?" Its answer tells you what to tighten.