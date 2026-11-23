# Proof: restore to an earlier time (2026-10-29)

Captured against the local stack. A fresh account wrote five files in
`Projects/` and `Clients/`. An agent key named "Claude Code" then rewrote
`plan.md`, deleted `checklist.md`, renamed `notes.md`, added three scratch
files and edited the Acme brief, all over REST.

| Still                         | What it shows                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `01-restore-before-this.png`  | The agent's burst in Activity, with **Restore to before this…** on the entry.                                            |
| `02-preview.png`              | The preview for the moment just before it: every one of the agent's 8 changes reversed, including the rename moved back. |
| `03-activity.png`             | After Restore: one entry, "restored 7 files to 21:23" (the rename is one change).                                        |
| `04-folder-details.png`       | **Restore to an earlier time…** in a folder's details panel.                                                             |
| `05-folder-picker-mobile.png` | The time picker for one folder at phone width, reached from the folder's **⋯**.                                          |
| `06-done.png`                 | A second run, applied: what changed, in the past tense.                                                                  |

Video walkthrough (activity → restore to before this → preview → restore → tree): https://files.catbox.moe/04f0js.webm

Not captured in the browser: the two-member privacy cases. They're covered by
`packages/api/test/recovery-pit.test.ts`, including a private folder that was
renamed and then shared after the moment restored to.