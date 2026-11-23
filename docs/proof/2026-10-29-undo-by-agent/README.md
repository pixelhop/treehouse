# Proof: undo what an agent did (2026-10-29)

Captured against the local stack. A fresh account, an agent key "Claude Code"
that rewrote, deleted, renamed and created files, Sam (the person) editing the
Acme brief after the agent had, and a second agent key "Cursor" adding its own
file in between.

| Still                | What it shows                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-activity.png`    | Activity entries with **Undo Claude Code's changes…** and **Restore to before this…**.                                                                                |
| `02-preview.png`     | The preview: every Claude Code change reversed (including the rename, moved back); the brief Sam edited afterwards left alone, naming him; Cursor's file not touched. |
| `03-undone.png`      | Activity afterwards: one entry, "undid 6 changes by Claude Code".                                                                                                     |
| `04-api-keys.png`    | **Undo changes…** beside each key in the API keys list.                                                                                                               |
| `05-undo-dialog.png` | The undo dialog opened from the API keys list.                                                                                                                        |
| `06-left-alone.png`  | A second run: Sam re-did the checklist by hand after the agent cleared it, so it's left alone.                                                                        |

Video walkthrough (activity → undo Claude Code's changes → preview with a file left alone → undo): https://files.catbox.moe/l3tshp.webm

Not captured in the browser: the agent-side tools (`preview_undo_my_changes`,
`undo_my_changes`), covered by `mcp.test.ts` against a running API, and the
privacy cases, covered by `recovery-undo.test.ts`.
Second review round (credential split):

| Still                    | What it shows                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `07-key-entry-split.png` | One person's write through a synced-folder key (`cli.md`) is its own entry between their browser writes.    |
| `08-key-undone.png`      | **Undo treehouse-cli's changes…** on that entry, applied from a confirmed preview: only `cli.md` is undone. |