# Guide media

The short videos on the guides (`public/guides/media/`) are recorded from a local
stack running the seeded "Acme Studio" workspace, like the docs screenshots. Retake a
clip when the flow it shows changes, or delete it rather than keep a stale one.

You need `agent-browser`, `vhs`, `ffmpeg` and `cwebp`.

## 1. Stack and seed

Follow steps 1 and 2 of [`../docs-screenshots/README.md`](../docs-screenshots/README.md),
then create the agent keys the scenes use:

```bash
export WORKSPACE_ID=<printed by seed.mjs> DATABASE_NAME=treehouse_docs_screens
node scenes.mjs keys
```

Sign in as Sam in an `agent-browser` session at 1360x850, scale 2. Before each take,
remove the Nuxt dev toolbar (see `shot.sh`) and collapse the sidebar's folders.
Record with `agent-browser record start raw/<name>.mp4 --cursor`, drive the flow with
`hover` then `click` on each control (a pause of a second or two between steps reads
well), and `agent-browser record stop`.

## 2. The clips

| Clip                      | Stage it                                       | Record                                                                                                                                                                              | Encode crop       | Poster at |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------- |
| `undo-an-agent`           | `node scenes.mjs agent-mistake`                | Activity page. Expand claude-code's "made 3 changes", **Undo claude-code's changes…**, **Preview changes**, **Undo changes**.                                                       | `2120:1700:600:0` | 11.5      |
| `agent-files-the-inbox`   | `node scenes.mjs inbox`                        | Activity page, freshly loaded. Expand inbox-filer's "made 6 changes", open `2026-09-30-holiday-countdown-idea.md`, then its `2026-09-29-call` link, whose **Linked from** lists it. | `2720:1700:0:0`   | 9.2       |
| `workspace-tour`          | nothing                                        | Workspace root with the details panel hidden. Sidebar: Projects, Website relaunch, Tasks (board), Meetings (calendar), **Previous month** twice to September. Trim at the calendar. | `2720:1700:0:0`   | 7.5       |
| `sync-to-your-own-server` | `node scenes.mjs approve` in a second terminal | `vhs sync-to-your-own-server.tape`                                                                                                                                                  | `1400:690:0:0`    | 26.2      |
| `board-is-a-folder`       | after the clip above                           | `vhs board-is-a-folder.tape`                                                                                                                                                        | `1400:600:0:0`    | 14.3      |

The tapes need `REPO` (the repo root) and `GUIDE_MEDIA_HOME` (an empty throwaway folder)
in the environment, and a current Node first on `PATH`: they run the CLI from source
under a fake home, so your own synced folders and sync daemon aren't touched.

Then encode each one:

```bash
./encode.sh raw/undo-an-agent.mp4 undo-an-agent 2120:1700:600:0 11.5
```

It crops, scales to 1280 wide, compresses to H.264 without audio, and writes
`<name>.mp4` and a `<name>.webp` poster to `public/guides/media/`. Aim for under about
300 KB a clip. Afterwards stop the servers and drop the database.