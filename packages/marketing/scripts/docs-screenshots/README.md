# Docs screenshots

The screenshots in `packages/marketing/public/docs/images/` are captured from a
local stack with a seeded, fictional workspace ("Acme Studio"), so they can be
regenerated whenever the UI changes. Retake a shot when the page it illustrates
changes; delete it rather than keep a stale one.

## 1. Run a local stack on a throwaway database

```bash
docker exec db-postgres-1 psql -U postgres -c "CREATE DATABASE treehouse_docs_screens"
# packages/api/.env: DATABASE_URL pointing at that database, BETTER_AUTH_URL=http://localhost:3110,
#   APP_URL=http://localhost:3100, fresh BETTER_AUTH_SECRET / SHARE_COOKIE_SECRET / BLOB_KEK,
#   BLOB_DIR somewhere disposable. packages/app/.env: NUXT_PUBLIC_API_URL=http://localhost:3110
(cd packages/db && pnpm exec prisma migrate deploy)
(cd packages/api && pnpm exec nitro dev --port 3110) &
(cd packages/app && TMPDIR=/tmp pnpm exec nuxt dev --port 3100) &
```

Billing stays off, so every limit is unlimited and no plan picker appears.

## 2. Seed the demo workspace

```bash
API_URL=http://localhost:3110 APP_URL=http://localhost:3100 \
  node packages/marketing/scripts/docs-screenshots/seed.mjs
```

It prints the workspace id, the two demo logins (Sam, the owner, and Priya, a
member) and the public share URL. The content lives in `seed-content.mjs`.

## 3. Capture

Sign in as Sam in an `agent-browser` session called `docs` at 1360x850, scale 2,
then navigate and run `shot.sh`:

```bash
agent-browser --session docs open http://localhost:3100/sign-in
agent-browser --session docs set viewport 1360 850 2
# ...sign in, navigate...
packages/marketing/scripts/docs-screenshots/shot.sh folder-calendar
packages/marketing/scripts/docs-screenshots/shot.sh members "Who can see Acme Studio"
```

| Image                  | Where                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace-overview`   | Workspace root, README front page                                                                                                                                              |
| `file-info`            | `Brand/tone-of-voice.md`, Info tab                                                                                                                                             |
| `version-history`      | Same file, History tab, a version's actions menu open                                                                                                                          |
| `comments`             | `Projects/Website relaunch/launch-announcement.md`, Comments tab                                                                                                               |
| `markdown-editor`      | Same file, **Edit**                                                                                                                                                            |
| `conflicted-copy`      | The conflicted copy of `Projects/Website relaunch/README.md`, Info tab                                                                                                         |
| `folder-calendar`      | `Meetings/`                                                                                                                                                                    |
| `folder-board`         | `Projects/Website relaunch/Tasks/`, sidebar and details panel hidden                                                                                                           |
| `folder-board-colours` | `Projects/Social videos/`, sidebar and details hidden, **Fields** open                                                                                                         |
| `share-panel`          | `Clients/Northwind/Deliverables/`                                                                                                                                              |
| `public-share`         | The public share URL in a signed-out session (`SESS=visitor`), `october-report.html`                                                                                           |
| `activity`             | The workspace's Activity page                                                                                                                                                  |
| `members`              | Account menu, **Members** (cropped to "Who can see Acme Studio")                                                                                                               |
| `api-keys`             | Account menu, **API keys**, create `claude-code` (cropped to "Key created — copy it now"). Replace the key text with `your-new-key-appears-here` in the page before capturing. |
| `appearance`           | Account menu, **Appearance** (cropped to "Theme")                                                                                                                              |
| `invite-link`          | Dashboard after **Create invite link** (cropped to "Invite someone to Acme Studio")                                                                                            |
| `setup-card`           | Priya's own, empty workspace (cropped to "Let an agent set this up")                                                                                                           |
| `device-approve`       | `POST /api/device/code`, then open its `verification_uri_complete` as Sam                                                                                                      |

Whole-window shots are then cropped to the part of the UI their page is about,
so they stay readable in the docs column (percentages of width and height,
from the top-left): `comments` x20 w80 h70, `file-info` x20 w80 h55,
`version-history` x20 w80 h45, `conflicted-copy` h70, `folder-calendar` x20
w80 h78, `folder-board` h53, `folder-board-colours` h54, `share-panel` x40 w60 h52, `activity` x30 w56, `markdown-editor` x20
w57 h50, `device-approve` x20 w80 h62. `cwebp -crop x y w h` does it.

Afterwards stop the servers and drop the database.