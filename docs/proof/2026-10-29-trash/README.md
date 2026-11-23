# Proof: the trash (2026-10-29)

Captured against the local stack. A fresh account, with an agent key named
"Claude Code" that wrote four files and deleted three of them over REST; the
person then deleted `Planning/roadmap.md` themselves in the browser session.

| Still               | What it shows                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `01-trash.png`      | The trash: newest deletion first, grouped by day, each with who deleted it ("you", or the agent's key name).                    |
| `02-preview.png`    | Restoring three selected files: the preview lists every change before anything happens.                                         |
| `03-restored.png`   | After Restore: the Research folder is back in the tree and the trash shows only what wasn't restored.                           |
| `04-left-alone.png` | The agent wrote a new `Planning/roadmap.md` while the preview was open. The restore leaves the agent's file alone and says why. |
| `05-activity.png`   | The activity drawer: each restore is one entry, "restored 2 files from the trash", never merged with the agent's own changes.   |
| `06-mobile.png`     | The trash at phone width.                                                                                                       |

Video walkthrough (select → preview → restore → tree → activity): https://files.catbox.moe/2j3sgp.webm

Not captured in the browser: another member's private files staying out of the
trash. That needs a second account in the same workspace. It is covered by the
`trash and privacy` tests in `packages/api/test/recovery-trash.test.ts`, which
also cover a file deleted while private whose folder was shared afterwards.