# Proof: opt-in scripts for HTML files (2026-09-02)

Captured against the local stack with a seeded workspace holding `deck.html` (a
three-slide deck whose ← / → controls are JavaScript), `probe.html` (a page that
reports what it can reach from inside the sandbox) and `plain.html` (an ordinary
page with no executable script, carrying a JSON-LD block).

| Still              | What it shows                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-prompt.png`    | The offer, floating over the corner of the inert preview. Shown only for pages that carry executable script.                                                                                 |
| `02-running.png`   | After Allow: slide 2 of 3, reached with a single ← / → press and no click into the frame first.                                                                                              |
| `03-menu.png`      | The same decision in the file top bar's overflow menu.                                                                                                                                       |
| `04-changed.png`   | The file changed after being allowed (v4). It loads inert and asks again, rather than inheriting the earlier yes.                                                                            |
| `05-isolation.png` | Reported from inside the running page: `origin` is `"null"`; `document.cookie`, `localStorage` and `parent.document` each throw `SecurityError`; a credentialed fetch to the API is refused. |

Video walkthrough (prompt → allow → arrow keys): https://files.catbox.moe/f1dw4n.webm

Not captured, because CDP cannot reach it: how this behaves inside the Electron
shell, whose subframe navigation allow-list is unchanged by this work (the
preview is a `srcdoc` frame, so no new origin is loaded).