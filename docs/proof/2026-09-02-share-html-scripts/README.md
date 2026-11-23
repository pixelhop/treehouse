# Proof: public shares can present a deck (2026-09-02)

Driven end to end against the local stack: a member creates a public link for
`deck.html` (a three-slide deck whose ← / → controls are JavaScript), then a
**second browser session holding no cookies at all** opens that link as the
client would.

| Still                             | What it shows                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-create-form.png`              | The new setting in the create-link form, and the caveat that appears when it is combined with a live link.                                              |
| `02-existing-link.png`            | The same setting on a link that already exists — the reason the PATCH route exists, since the URL is usually already sent.                              |
| `03-client-presenting.png`        | The visitor's view: slide 2 of 3 after one arrow key, with no session, no prompt, and no account.                                                       |
| `05-enable-confirm.png`           | Enabling on an already-distributed live link asks first, and offers pinning to the version on screen (added after review).                              |
| `06-folder-has-no-control.png`    | A folder link is offered no such control at all — its rewritten URLs carry the share token.                                                             |
| `07-pin-refuses-changed-file.png` | "Pin this version" naming bytes that changed while the dialog was open: refused with the API's own sentence, nothing granted.                           |
| `08-unconfirmed-outcome.png`      | A toggle whose answer never arrived: the row admits it does not know, blocks further changes, and offers a re-check — rather than guessing "unchanged". |
| `04-client-inert-when-off.png`    | The same link with the setting turned back off: still slide 1 after an arrow key. Inert, as every share was before this change.                         |

Confirmed from the visitor's session while presenting: the frame carries
`allow-scripts allow-popups allow-popups-to-escape-sandbox` (no same-origin), and
`document.cookie` on the share page is empty — the visitor really is
unauthenticated, and the page really is in an opaque origin.

Folder shares are refused this capability outright (their rewritten URLs carry
the share token), so a shared deck must be self-contained — see the solutions
doc. Verified after review: the folder create form offers no such control, and
both routes answer 400.

Not captured: the phishing scenario the abuse note in
`docs/solutions/architecture-patterns/executing-untrusted-html.md` describes.
It's a policy trade, not a behaviour to screenshot.