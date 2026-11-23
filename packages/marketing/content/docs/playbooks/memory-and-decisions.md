---
title: Give your agents a memory
navTitle: Memory and decisions
description: Status pages, decision records and handoff notes that let any agent pick up where the last session left off.
type: guide
position: 5
updated: 2026-10-29
related:
  - /docs/playbooks/write-your-agents-md
  - /docs/playbooks/multiple-agents
  - /docs/files/folder-pages
---

Agents start every session knowing nothing about yesterday. Whatever they learned, decided or left half-finished is gone, unless it was written down somewhere the next session will look. A shared workspace is that somewhere. Three kinds of file do most of the work.

## A status page for each piece of work

Give every project or piece of ongoing work a single page that says where it stands. The folder's `README.md` is the natural place: it's the folder's [front page](/docs/files/folder-pages) in the web app, so people see it too.

```markdown [Projects/website-relaunch/README.md]
---
title: Website relaunch
status: in-progress
owner: Sam
---

## Where we are

Homepage and pricing copy are final. Blog migration is half done: posts up to
2024 are moved, the rest are in Inbox/blog-export/.

## Next

- Migrate the remaining posts (agent)
- Review the new navigation (Sam, by Friday)

## Open questions

- Do we keep the old /resources URLs? Waiting on SEO advice.

## Log

- 2026-09-29: Moved 2023-2024 posts. Found 12 with broken images, listed in
  migration-issues.md.
- 2026-09-26: Pricing copy signed off (see Decisions/2026-09-26-pricing-copy.md).
```

Then make it a rule in [AGENTS.md](/docs/playbooks/write-your-agents-md):

```markdown
- Before working on a project, read its README.md.
- When you finish, update "Where we are" and "Next", and add a line to "Log".
```

That one habit does more for continuity than anything else. Tomorrow's agent reads the page and knows what today's agent did, what's next and what's blocked.

## A record of every decision

Decisions are the context that disappears fastest. Six months on, nobody remembers why the pricing page doesn't mention the free plan, and an agent tidying things up will happily "fix" it. Keep one short file per decision in `Decisions/`, and make the folder a calendar so they're easy to browse by date:

```markdown [Templates/decision.md]
---
title: Short title of the decision
date: 2026-09-29
status: decided
---

## Decision

What we decided, in one or two sentences.

## Why

The reasons, and the options we didn't choose.

## Consequences

What changes because of this, and what to watch for.
```

Tell agents to check `Decisions/` before changing something that looks deliberate, and to write a decision file when you make a call in conversation with them: "Record that as a decision."

## Handoff notes between sessions

When a session ends mid-task, ask the agent to leave a note:

```text
We're stopping here. Update the project README with where we got to, what's
next and anything you were unsure about, so the next session can pick it up.
```

For longer pieces of work, some teams keep a `NOTES.md` next to the work itself: a scratchpad the agent reads at the start and appends to as it goes. Make it [private](/docs/files/private-files) if it's only for you and your agents.

## Keep memory honest

- **Link, don't copy.** A status page should link to the spec, not paste it. Copies go stale. A [wikilink](/docs/files/link-notes) like `[[Spec]]` survives the spec being renamed, and the spec's **Linked from** list shows every page that depends on it.
- **Date everything.** Log entries and decisions with dates can be trusted, or at least questioned, later.
- **Prune.** Once a project is done, ask an agent to summarise the log into the README and move the working files to `Archive/`. The history is still there if you need it: Treehouse keeps every [version](/docs/files/version-history).