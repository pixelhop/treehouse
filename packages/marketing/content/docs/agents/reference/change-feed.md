---
title: Change feed
description: Read every change to a workspace in order with a cursor, so a script or agent can react to new and edited files.
type: reference
position: 4
updated: 2026-10-30
related:
  - /docs/sharing/activity
  - /docs/playbooks/routines
  - /docs/agents/handbook/versions-and-conflicts
---

Every write, move, delete, conflict, restore and comment in a workspace is recorded in order with a sequence number. The sync CLI uses this feed to keep folders up to date, the [activity feed](/docs/sharing/activity) is built on it, and you can read it too.

Treehouse doesn't push webhooks. You poll the feed from your own process, as often as you need.

## Request

```http
GET /api/workspaces/{workspaceId}/changes?sinceSeq=0&limit=200
x-api-key: th_example_key
```

| Parameter         | Default | Description                                                                                   |
| ----------------- | ------- | --------------------------------------------------------------------------------------------- |
| `sinceSeq`        | -       | Return changes with a sequence number greater than this. Use `0` to start from the beginning. |
| `limit`           | `200`   | Changes to scan, from 0 to 1000.                                                              |
| `includeComments` | off     | `1` or `true` to include `comment_*` events.                                                  |

## Response

```json
{
  "changes": [
    {
      "id": "0b6f…",
      "workspaceId": "c2a1…",
      "path": "Inbox/call-notes.md",
      "op": "write",
      "version": 1,
      "principal": "human",
      "actorId": "u_91…",
      "actorKeyId": null,
      "actorLabel": null,
      "contentHash": "5e88…",
      "relatedPath": null,
      "operationId": null,
      "seq": 1042,
      "createdAt": "2026-09-29T09:12:44.103Z"
    }
  ],
  "operations": [],
  "head": 1042,
  "nextSeq": 1042
}
```

| Field        | Meaning                                                                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes`    | Changes after your cursor that you're allowed to see, oldest first                                                                                                                                                                                                                                       |
| `head`       | The workspace's latest sequence number right now                                                                                                                                                                                                                                                         |
| `operations` | The recoveries behind any `operationId` in this page: `{ id, kind, scopePath, targetAt, targetLabel }`. `kind` is `trash` for files restored from the trash, `restore` for a restore to an earlier time (with `targetAt` and `scopePath`), and `undo` for one key's changes undone (with `targetLabel`). |
| `nextSeq`    | The cursor for your next request. Store it.                                                                                                                                                                                                                                                              |

### Using the cursor

- **Start** at `sinceSeq=0` to replay the whole history, or read `head` first to start from now: a request with `limit=0` returns `head` without any changes.
- **Always continue from `nextSeq`**, not from the last change you received. Changes you aren't allowed to see (another member's private files, or comments you didn't ask for) are filtered out, and `nextSeq` still moves past them. A page can come back empty with a higher `nextSeq`.
- **You're caught up** when `nextSeq` equals `head`. Until then, request again straight away.
- Sequence numbers always increase but can have gaps. Don't expect every number to appear.

## Change fields

| Field         | Description                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `seq`         | Position in the feed                                                                                                             |
| `path`        | The file (or, for access events, the file or folder) the change applies to                                                       |
| `op`          | What happened. See below.                                                                                                        |
| `version`     | The file's version after the change. For a `delete`, the version that was deleted. `null` for access events.                     |
| `principal`   | `agent` or `human`, from the acting key's actor type. OAuth connections are always `agent`; browser sessions are always `human`. |
| `actorId`     | The user id behind the change. `GET /api/workspaces/{id}/members` maps it to a name.                                             |
| `actorKeyId`  | The API key that made the change, `oauth:<connection id>` for an OAuth connection, or `null` for a browser session               |
| `actorLabel`  | The key's or connection's name at the time of the change, such as `claude-code`                                                  |
| `contentHash` | SHA-256 of the new content for `write`, `move`, `restore` and `conflict`, otherwise `null`                                       |
| `relatedPath` | For a move, the other end: the new path on its `delete`, the old path on its `move`. Otherwise `null`.                           |
| `operationId` | Set when the change was part of a recovery, such as restoring files from the trash. Otherwise `null`.                            |
| `createdAt`   | Server timestamp                                                                                                                 |

`actorKeyId` is set for any key, including human CLI keys, and for OAuth connections, so use `principal` to tell agents from people.

## Operations

| `op`               | Meaning                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `write`            | A file was created or updated, including one recreated after a delete                                                          |
| `move`             | A file arrived at `path` by a move or rename. Paired with a `delete` at its old path, and `version` is 1.                      |
| `delete`           | A file was deleted, or moved away from `path` (then `relatedPath` is where it went)                                            |
| `conflict`         | A conflicted copy was created at `path`                                                                                        |
| `restore`          | An earlier version was restored as a new version, or a deleted file came back from the trash (numbered after its last version) |
| `access_revoked`   | You could see an item and now you can't. Drop your copy of `path` and everything under it.                                     |
| `access_granted`   | Who can see an item widened and you can see it now. Not sent to the person who changed it.                                     |
| `comment_created`  | A comment thread was started on the file at `path`                                                                             |
| `comment_replied`  | Someone replied to a thread                                                                                                    |
| `comment_resolved` | A thread was resolved                                                                                                          |
| `comment_reopened` | A resolved thread was reopened                                                                                                 |

The `comment_*` operations only appear with `includeComments=1`.

## Time-based mode

The web app's activity panel reads the feed by time instead: `?since=<ISO timestamp>`, optionally with `order=desc` for newest first. This mode returns `changes` and `head` but no `nextSeq`, and orders by timestamp. Use `sinceSeq` for anything that must not miss a change.

## Example: poll for new files

This loop polls every two seconds, the same interval the sync CLI uses, and reacts to new files in `Inbox/`. It saves its cursor so a restart picks up where it left off.

```typescript [watch-inbox.ts]
import { readFile, writeFile } from "node:fs/promises";

const API = "https://api.trytree.house";
const KEY = process.env.TREEHOUSE_API_KEY!;
const WS = process.env.TREEHOUSE_WORKSPACE_ID!;
const CURSOR_FILE = ".treehouse-cursor";

type Change = { seq: number; path: string; op: string; version: number | null; principal: string };
type Page = { changes: Change[]; head: number; nextSeq: number };

async function loadCursor(): Promise<number> {
  try {
    return Number(await readFile(CURSOR_FILE, "utf8"));
  } catch {
    // First run: start from now rather than replaying the whole history.
    const page = await fetchPage(0, 0);
    return page.head;
  }
}

async function fetchPage(sinceSeq: number, limit = 500): Promise<Page> {
  const res = await fetch(
    `${API}/api/workspaces/${WS}/changes?sinceSeq=${sinceSeq}&limit=${limit}`,
    { headers: { "x-api-key": KEY } },
  );
  if (!res.ok) throw new Error(`change feed: ${res.status}`);
  return (await res.json()) as Page;
}

async function onChange(c: Change): Promise<void> {
  const arrived = (c.op === "write" && c.version === 1) || c.op === "move";
  if (arrived && c.path.startsWith("Inbox/")) {
    console.log(`New in Inbox: ${c.path} (by ${c.principal})`);
    // Hand it to your agent here.
  }
}

let cursor = await loadCursor();
for (;;) {
  const page = await fetchPage(cursor);
  for (const change of page.changes) await onChange(change);
  cursor = page.nextSeq;
  await writeFile(CURSOR_FILE, String(cursor));
  if (cursor >= page.head) await new Promise((r) => setTimeout(r, 2000));
}
```

Save the cursor after you've handled a page, not before, so a crash replays the page instead of skipping it. That means your handler may see a change twice; make it safe to repeat.

## Ideas

- **An inbox agent.** Watch `Inbox/` as above and start an agent on each new file, so notes you drop in are filed or summarised. The [routines playbook](/docs/playbooks/routines) covers running agents on a schedule.
- **A daily digest.** Once a day, read from yesterday's saved cursor to `head`, group changes by `path` and `principal`, and write a summary file back to the workspace.
- **Review triggers.** With `includeComments=1`, watch for `comment_created` on files your agent owns and have it respond. See the [review loop playbook](/docs/playbooks/review-loop).

Remember that Treehouse only stores the files and the feed: the process doing the polling runs on your own machine or server.