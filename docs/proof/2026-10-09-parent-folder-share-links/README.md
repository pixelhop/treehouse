# Proof: copy a child's link from a public parent folder (2026-10-09)

Driven against the local stack. A member shares `Clients/Acme` publicly, then
opens files and folders inside it. A **second browser session with no cookies**
opens the copied links the way a visitor would.

| Still                               | What it shows                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `01-file-in-public-folder.png`      | The Share tab on `proposal.md`: the inherited-share notice now has **Copy link to this file**.                              |
| `02-visitor-lands-on-file.png`      | The copied link (`/s/<token>?p=Clients%2FAcme%2Fproposal.md`) opened signed out: the folder viewer, with the file selected. |
| `03-subfolder.png`                  | The same control on a sub-folder, worded **Copy link to this folder**.                                                      |
| `04-password-parent.png`            | A password-protected parent link: lock icon, and "Opens with the folder's password."                                        |
| `05-visitor-unlocked-deep-link.png` | A deep link to `notes/kickoff.md` through the password gate: after unlocking, the visitor is on that file.                  |

`06-visitor-empty-subfolder.png`: added after the Codex review. A deep link to an empty
sub-folder now opens it ("This folder is empty.") instead of "isn't part of this share".

Also confirmed against the API: a private file inside the public folder now
lists no inherited share, because the folder link does not serve it.