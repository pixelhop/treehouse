---
title: Plans and limits
description: What Seedling, Grove and Forest include, how usage is counted, and what happens when a workspace reaches a limit.
type: reference
position: 1
updated: 2026-10-29
related:
  - /docs/account/billing
  - /docs/sharing/invite-people
  - /docs/sharing/share-links
---

|                                     | Seedling (free) | Grove     | Forest    |
| ----------------------------------- | --------------- | --------- | --------- |
| Storage per workspace               | 1 GB            | 50 GB     | 250 GB    |
| Files per workspace                 | 1,000           | 25,000    | 100,000   |
| Largest single file                 | 25 MB           | 100 MB    | 100 MB    |
| Workspaces you can own on this plan | 1               | Unlimited | Unlimited |
| Members per workspace               | 1               | Unlimited | Unlimited |
| Public share views a month          | 500             | Unlimited | Unlimited |

Every plan includes the same features: syncing, the MCP server and API, version history, comments, activity, public share links and connecting as many agents as you like. What changes is how much a workspace can hold and how many people can join it.

Grove and Forest are priced per member, per month, and can be paid monthly or yearly. You'll see the current prices when you choose a plan. See [billing](/docs/account/billing).

## How usage is counted

Limits apply per workspace. A workspace's plan covers that workspace only, so each of your workspaces has its own storage, file count and share views.

- **Storage** is the total size of the current version of every file. Older versions in history and deleted files in the trash don't count.
- **Files** counts the files in the workspace now. Deleted files in the [trash](/docs/files/trash) don't count, until you restore them.
- **Members** are the people in the workspace. Agents, API keys and visitors on share links are never members, on any plan.
- **Workspaces you can own** counts free workspaces where you're the owner. Workspaces you've been invited into don't count, and paid workspaces don't use up your free one.
- **Share views** count one visitor opening one public link on one day, however many files they look at. Bots and link previews aren't counted. The count resets each month.

You can see a workspace's **Files**, **Storage** and **Share views** in its details panel: open the workspace's front page and look at the right-hand panel.

## Getting close to a limit

When a workspace reaches 90% of its storage or file limit, its usage bars in the details panel turn to a warning colour. On Seedling, the owner is also emailed when the workspace's public links are getting close to the month's share views.

## What happens at a limit

Nothing is ever deleted because of a limit. Reading, downloading, moving and deleting files always keep working, so you can always tidy up.

- **Storage or file limit:** new files and edits that would go over are refused, with a message saying which limit was reached. Delete some files or [upgrade](/docs/account/billing) to carry on. Agents get the same answer: the MCP write tools return a result flagged `quotaExceeded` (storage) or `fileCountExceeded` (file count), with the numbers, instead of an error they might retry.
- **Largest file:** a file over the limit is refused. The desktop app and CLI skip it and note it in the sync log.
- **Members:** on Seedling, creating an invite link shows **Your plan is for one person**. See [invite people](/docs/sharing/invite-people).
- **Workspaces:** creating a second free workspace shows **You've used your free workspace**, with the option to create it on a paid plan instead.
- **Share views:** the workspace's public links pause until the start of next month. Visitors see "This link is temporarily unavailable." with no mention of plans, and the owner is emailed. Upgrading brings every link back immediately.

::callout{type="agent"}
If a write returns `quotaExceeded` or `fileCountExceeded`, don't retry it. Tell the person you're working for which limit was reached; freeing storage won't help with a file-count limit, and the reverse.
::