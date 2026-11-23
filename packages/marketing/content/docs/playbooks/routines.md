---
title: Set up routines
navTitle: Routines
description: Recurring agent work, like a morning inbox run or a weekly review, and where the schedule lives when Treehouse doesn't run agents itself.
type: guide
position: 6
updated: 2026-11-23
related:
  - /docs/playbooks/inbox-and-filing
  - /docs/desktop/sync-with-the-cli
  - /docs/agents/reference/change-feed
---

Some of the most useful agent work is routine: filing the inbox every morning, drafting a weekly summary, checking which specs haven't been touched in a month. Treehouse is where that work lands, but it doesn't run agents or keep a schedule. The routine lives wherever your agent runs; the workspace gives it the rules and a place to write.

## Write the routine down first

Put each routine's instructions in the workspace, not in the scheduler. Then the scheduled command stays one line, and anyone can read or improve what the routine does.

```markdown [Routines/weekly-review.md]
---
title: Weekly review
---

Every Friday afternoon:

1. Read every project README in Projects/.
2. Write Reviews/YYYY-MM-DD-weekly.md with `date:` set to today, covering:
   what moved this week, what's blocked, and anything overdue in "Next".
3. List any project README not updated in 14 days as "Needs attention".
4. Don't change the project files themselves.
```

The scheduled prompt is then just: "Run the routine in Routines/weekly-review.md."

## Choose where it runs

### On your computer, with Claude Code and cron

If the workspace is [synced](/docs/desktop) to your Mac, a cron job can run Claude Code in the folder without you there. `claude -p` runs a single prompt non-interactively, and `--permission-mode acceptEdits` lets it create, edit and move files without asking:

```bash
# crontab -e: file the inbox at 8am on weekdays
0 8 * * 1-5 cd ~/Treehouse/Acme && claude -p "Process everything in Inbox/ following the rules in Inbox/README.md." --permission-mode acceptEdits >> ~/Library/Logs/treehouse-inbox.log 2>&1
```

Your computer needs to be awake. Changes sync to the workspace as soon as they're written, and show up in Activity as yours.

### On a server, with the sync CLI

For routines that shouldn't depend on your laptop, run the [sync CLI](/docs/desktop/sync-with-the-cli) on an always-on Mac to keep a copy of the workspace there, and schedule your agent against that folder the same way. Approve that machine as its own device so you can revoke it separately.

### In the cloud, over MCP

A hosted or cloud agent that supports remote MCP servers can do the same work over the Treehouse MCP server. If it can sign in through your browser, [connect it](/docs/agents/connect/other-agents) and name it for the routine; if it runs where no one can sign it in, give it its own [API key](/docs/agents/connect/api-keys). Its changes are labelled with that name, which makes routine work easy to spot in the [activity feed](/docs/sharing/activity).

### A reminder

Automation you don't need is still worth skipping. A weekly calendar reminder to ask your agent "Run the weekly review" is a fine first version, and tells you whether the routine is worth automating.

## Routines worth having

| Routine           | What it does                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Inbox run         | Files everything in `Inbox/` by the rules in `Inbox/README.md`. See [run an inbox](/docs/playbooks/inbox-and-filing). |
| Weekly review     | Summarises what moved across projects and flags what's stalled.                                                       |
| Meeting follow-up | Turns the day's notes in `Meetings/` into actions on the relevant project pages.                                      |
| Content calendar  | Drafts next week's posts in a calendar folder, each dated for its publish day, ready for review.                      |
| Stale-page check  | Lists READMEs and specs not updated in a month, so someone can confirm they're still true.                            |
| Comment sweep     | Works through open [review comments](/docs/playbooks/review-loop) on files marked `status: review`.                   |

## Plan with a calendar folder

For anything with a date, like a content plan, a release schedule or a series of client check-ins, make a folder that [opens as a calendar](/docs/files/folder-pages). Put `view: calendar` in its README, and have the agent give each file a `date:`:

```markdown [Content/2026-10-06-pricing-announcement.md]
---
title: Pricing announcement
date: 2026-10-06
status: draft
---
```

The web app shows the month at a glance. Drag a post to another day to reschedule it, and its `date:` is rewritten for you.

## React to changes instead of a clock

If you're comfortable with a little code, you can trigger an agent when something changes rather than at fixed times: watch the workspace's [change feed](/docs/agents/reference/change-feed) for new files in `Inbox/`, and run your agent when one appears. Treehouse doesn't send webhooks, so the watcher polls; every couple of seconds is fine.