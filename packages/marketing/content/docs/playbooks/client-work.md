---
title: Run client work
navTitle: Client work
description: A folder per client, agents that prepare the deliverables, and share links that give clients exactly what they should see.
type: guide
position: 8
updated: 2026-09-29
related:
  - /docs/sharing/share-links
  - /docs/files/html-pages
  - /docs/playbooks/review-loop
---

Agencies and freelancers get a lot from a shared workspace: every client's context in one place, agents that know the brief, and a way to hand work to clients without emailing attachments. This playbook puts those together.

## 1. One folder per client, split by audience

```text
Clients/
  Acme/
    README.md        the client's front page: who they are, contacts, status
    Brief/           what they've asked for, in their words
    Notes/           internal: calls, research, our thinking
    Deliverables/    what the client sees
```

Keep what the client sees apart from what they don't. A [share link](/docs/sharing/share-links) to a folder covers everything inside it, so if `Deliverables/` is the folder you share, internal notes must never go in it. Write that into the client folder's README and your [AGENTS.md](/docs/playbooks/write-your-agents-md):

```markdown
- Clients/<name>/Deliverables/ is shared with the client. Only finished,
  client-ready work goes there. Nothing internal, no pricing notes, no drafts.
```

## 2. Give agents the context

The client README is where an agent starts. Put the essentials there: what the client does, who you deal with, the current engagement and its status, and links to the brief and the latest deliverables. Keep call notes in `Notes/` with dates, and ask an agent to update the README's status after each call.

Then any agent can work on the account without a briefing: "Read Clients/Acme/README.md and the brief, then draft the October report in Clients/Acme/Notes/drafts/."

## 3. Draft, review, deliver

1. The agent drafts into `Notes/drafts/`, with `status: review` in the front matter.
2. You and your team [review it with comments](/docs/playbooks/review-loop), and the agent revises.
3. When it's ready, the agent (or you) moves it into `Deliverables/`.

A report doesn't have to be markdown. Agents are good at building a self-contained **HTML page** with charts and styling, and Treehouse [renders HTML files](/docs/files/html-pages) as pages. Scripts in them only run once you allow them.

## 4. Share with the client

Open the file or the `Deliverables/` folder, choose the **Share** tab, and create a public link:

- **Password protect** it for anything confidential, and send the password separately.
- **Pin it to a version** when the client is signing something off. The link keeps showing exactly that version, even after you keep working on the file.
- Use a **live link** on the `Deliverables/` folder for an ongoing engagement, so the client always sees the latest.

The client gets a clean, read-only view of the files: no sign-up, no comments, no sidebar of your other work. You can see how many times the link was opened, and **Revoke** it the moment the engagement ends. [Share links](/docs/sharing/share-links) has the details, including view limits on the free plan.

## 5. Capture what comes back

When a client replies with feedback, drop it into the client's `Notes/` (or the workspace [Inbox](/docs/playbooks/inbox-and-filing)) and ask an agent to turn it into changes: "Here's Acme's feedback on the October report. Draft the revisions and list anything we should push back on."

## Keep clients apart

Everyone in a workspace can see every client folder. If some clients' work must be kept from some of your team, use separate workspaces for them: each workspace has its own members, and joining one gives access to nothing else.