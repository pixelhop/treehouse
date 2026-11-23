---
title: Run an inbox your agent files
navTitle: Inbox and filing
description: Drop anything into Inbox/ without deciding where it goes, and have an agent file it by rules you write once.
type: guide
position: 3
updated: 2026-09-29
related:
  - /docs/playbooks/routines
  - /docs/playbooks/second-brain
  - /docs/playbooks/shape-your-workspace
---

Knowledge bases rarely die from a lack of folders. They die because filing something means deciding where it goes at exactly the moment you're busy. An inbox removes that decision: drop anything into `Inbox/`, unnamed and unsorted, and let an agent file it later using rules you've written down.

## 1. Create the Inbox and its rules

If an agent set up your workspace, you already have an `Inbox/` with a `README.md`. If not, create one. The README is the filing policy: specific to your workspace, using your folders, in your words.

```markdown [Inbox/README.md]
---
title: Inbox
---

Drop anything here: a link, a note, a screenshot, a half-formed thought. No
need to name it well or decide where it belongs.

## How this gets filed

- Anything about a customer or an account → Customers/<customer name>/
- Pricing, suppliers or how-we-do-it notes → Operations/
- Wording, logos, photos or tone of voice → Brand/
- Notes from a conversation → Meetings/, with a `date:` in the front matter
- A decision we've made → Decisions/, using Templates/decision.md
- Genuinely unclear → leave it here and list it in the summary

## Rules for whoever files

- Never delete anything from the Inbox. Only move.
- Give moved files a clear name (YYYY-MM-DD-what-it-is.md for dated things).
- If a note belongs in an existing file, add it there and move the original to
  Archive/inbox/.
- Leave anything you're not sure about. A wrong filing is worse than none.

Empty is the goal, not full.
```

Two rules matter more than the rest: **never delete, only move**, and **when in doubt, leave it**. A filing system that loses things gets abandoned faster than one that stays a bit messy.

## 2. Get things into it

Anyone can add to the Inbox, any way they like:

- **From your computer**, save or drag files into the `Inbox` folder inside your [synced folder](/docs/desktop).
- **From the web app** (on your phone too), select the Inbox folder and create a note with **New file**, or [upload](/docs/files/upload-and-download) a photo or document.
- **From an agent**, ask it to "put this in the Inbox" at the end of a conversation.

## 3. Process it

When you want the Inbox cleared, ask an agent connected to the workspace:

```text
Process everything in Inbox/ following the rules in Inbox/README.md.
File what is clear, leave what is not, and tell me what you moved and what
you left behind.
```

The instruction stays short because the rules live in the workspace. Any agent, in any session, files things the same way. If the result isn't what you wanted, don't fix it by hand and move on: change the rules in `Inbox/README.md` so it's right next time.

## 4. Make it a habit

Treehouse doesn't run agents on a schedule, so "later" has to come from somewhere. Pick whichever fits how you work:

- **A reminder.** A weekly calendar reminder to say "process my inbox" is a perfectly good first version.
- **A scheduled agent.** Run the prompt above every morning from wherever your agent runs. [Routines](/docs/playbooks/routines) has examples for Claude Code and cron.

## Check it's working

After a processing run, look at the [activity feed](/docs/sharing/activity): every move is listed, so you can check where things went. Anything left in the Inbox should be genuinely ambiguous. If the same kind of item keeps getting left behind, it needs a rule.