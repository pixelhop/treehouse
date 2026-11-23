---
title: Work with several agents
navTitle: Several agents
description: Give each agent its own key and its own lane, hand work over through files, and let versioning catch the collisions.
type: guide
position: 7
updated: 2026-10-29
related:
  - /docs/agents/connect/api-keys
  - /docs/playbooks/memory-and-decisions
  - /docs/files/conflicted-copies
---

Once one agent is useful, you'll want more: one that files the inbox, one that drafts, one that reviews. They can share a workspace safely, because every write is checked against the version it was based on. Nobody overwrites anybody. What they need from you is enough structure that they don't trip over each other.

## Give each agent its own name

Connect each agent over MCP separately, and name it after its job when you approve it: `inbox-filer`, `drafter`, `reviewer`. Agents that sign in through the browser are named on the approval screen and can be [renamed later](/docs/agents/connect/connected-agents); agents that can't open a browser get their own [API key](/docs/agents/connect/api-keys), named the same way. In the [activity feed](/docs/sharing/activity) each one's changes are grouped under its own name, so you can see who did what, and you can disconnect one without affecting the rest.

Agents working in your [synced folder](/docs/desktop) all appear as you. If you need to tell them apart, have them connect over MCP instead, or ask each to sign its log entries.

## Give each agent a lane

Collisions are rare when agents work in different places. Write the lanes into [AGENTS.md](/docs/playbooks/write-your-agents-md):

```markdown
## Who does what

- inbox-filer: moves files out of Inbox/. Never edits file contents.
- drafter: writes in Drafts/ and Specs/. Sets status: review when done.
- reviewer: comments on files marked status: review. Never edits them.

If you're not one of these, ask before working in their folders.
```

Folders make natural lanes. So does front matter: an agent can claim a file by setting `owner:` before it starts, and others leave it alone until it's released.

## Hand work over through files

Agents don't talk to each other directly; they talk through the workspace. A handoff is just a file in the right place:

- The drafter finishes and sets `status: review`. The reviewer's routine looks for that status.
- The reviewer leaves [comments](/docs/sharing/comments). The drafter's next run addresses open threads.
- Anything bigger goes on the project's status page, under "Next", with a name against it. See [give your agents a memory](/docs/playbooks/memory-and-decisions).

Because handoffs are files, you can read every one of them, and step in at any point.

## When two agents touch the same file

It still happens occasionally, and Treehouse handles it. The second agent's write doesn't overwrite the first; it's kept as a [conflicted copy](/docs/files/conflicted-copies) next to the original, and the agent is told. Agents following the [handbook](/docs/agents/handbook) re-read the file, merge their change and delete the copy. If you find conflicted copies piling up, two agents' lanes overlap: tighten the rules.

## Give agents somewhere private to work

An agent's scratch work, like half-finished research or intermediate notes, doesn't need to be in everyone's way. Put it in a folder [made private](/docs/files/private-files) by the person whose key the agent uses. Only that person and their keys can see it; other people and their agents can't.