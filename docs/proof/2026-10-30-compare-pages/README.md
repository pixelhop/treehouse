# Comparison pages: proof

Page screenshots are from the production build running on the local Cloudflare
Worker runtime (`wrangler dev`), at 1440px and 390px.

## Obsidian vault test, 30 October 2026

**In the real Obsidian desktop app** (isolated profile, stopped at the owner's
request part way through):

- Obsidian opened a Treehouse-synced folder as a vault and wrote its own
  `.obsidian/` (`app.json`, `appearance.json`, `core-plugins.json`,
  `workspace.json`). All of it synced by default.
- Two copies open at once started cleanly, with no conflicts.
- Two copies moving between notes made five conflicted copies of
  `.obsidian/workspace.json` in under a minute.
- Each window kept its own open note while the file on disk was shared.

**Not tested in the app, because it was stopped:** renaming a note inside
Obsidian while a teammate has the vault open, how an open note reacts to an
incoming change, whether a conflicted copy shows in the file explorer, real
community plugins, pasting attachments, and Obsidian's mobile apps. The Treehouse
desktop app wasn't used either: sync was the CLI, which shares its engine.

**With files, the sync CLI, MCP and the web app only**, re-run after #141 and #146
merged:

| Check                                     | Result                                                 |
| ----------------------------------------- | ------------------------------------------------------ |
| `[[wikilinks]]`, aliases, missing notes   | Links; missing notes are greyed out                    |
| `![[embed]]`                              | A link, not the file                                   |
| Markdown image                            | Shown                                                  |
| Inline and front matter tags              | Read, including nested; listed on the note             |
| Callouts, highlights, Mermaid             | Raw text                                               |
| `%%hidden comment%%`                      | Visible, including on a public link                    |
| `.canvas`, `.base`                        | Sync; download only (checked before the rebase)        |
| Agent rename over MCP                     | Links in other notes updated                           |
| Rename by hand in a synced folder         | Other notes keep the old link                          |
| Same note edited in two folders           | A conflicted copy beside the note                      |
| Zero-byte note                            | Doesn't sync; `PUT` returns 400 and the client retries |
| `.obsidian/plugins/*/data.json`, `.trash` | Sync to everyone                                       |
| Public folder link: wikilink outside it   | Greyed out                                             |
| Public folder link: image outside it      | Broken                                                 |
| New workspace                             | Adds `AGENTS.md` and `README.md` to the folder         |

## Signup attribution, 30 October 2026

The app was pointed at a local sink instead of PostHog, and a new account was
created through a tagged link. The sink received:

| Event       | `$current_url` | `utm_campaign`     | `utm_content` | Person                                       |
| ----------- | -------------- | ------------------ | ------------- | -------------------------------------------- |
| `$pageview` | `/sign-up`     | `compare-obsidian` | `hero`        |                                              |
| `$identify` | `/sign-up`     | `compare-obsidian` | `hero`        | `$initial_utm_campaign`, anonymous id merged |
| `$pageview` | `/plans`       | `compare-obsidian` | `hero`        |                                              |

The query string stays out of `$current_url`, as `redactUrl` intends. PostHog drops
headless browsers as bots, so `opt_out_useragent_filter` was switched on inside the
test page. Nothing else about the events was changed.

## Speed comparison, 30 October 2026

Measured on an Apple M1 Pro, as the median of seven runs, over generated Markdown notes of about 6 KB each:

| Notes  | `cat` every note | `grep -rl` for a phrase |
| ------ | ---------------- | ----------------------- |
| 1,000  | 24 ms            | 61 ms                   |
| 10,000 | 174 ms           | 570 ms                  |

Notion's figures are calculated rather than measured: one request a page, at its published 180 or 600 requests a minute per connection, spent in fixed 60-second windows. No Notion workspace was tested.

## Obsidian layout files, 30 October 2026

After excluding `.obsidian/workspace.json` and `workspace-mobile.json` from sync, on a real local API with two synced folders and files only (Obsidian wasn't running). The workspace was seeded with the layout file, as an older client would have left it.

| Check                                                | Result                         |
| ---------------------------------------------------- | ------------------------------ |
| Both folders rewrite the layout every second for 15s | 0 conflicted copies            |
| The copy already in the workspace                    | Left alone, still at version 1 |
| Each person's local layout                           | Kept, and never overwritten    |
| Other `.obsidian` settings                           | Still sync both ways           |

Before the fix, a test showed that adding the file to the ignore list alone would have deleted the workspace's copy for everyone, because reconcile read "not scanned" as "deleted locally". Both ways into reconcile now skip ignored paths.