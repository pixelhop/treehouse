---
title: "Executing untrusted HTML in the file viewer (opt-in scripts mode)"
date: 2026-09-02
category: docs/solutions/architecture-patterns/
module: "packages/app/app/utils/htmlSandbox.ts"
problem_type: architecture_pattern
component: file-viewer
severity: high
applies_when:
  - "letting a workspace HTML file run its own JavaScript (slide decks, charts, interactive pages)"
  - "deciding who consents on a public share, where the viewer is an unauthenticated stranger"
  - "persisting a per-file permission, or deciding what invalidates one"
  - "changing the iframe sandbox tokens on the HTML preview"
  - "wondering why images break, or links open a new tab, once scripts are enabled"
  - "proposing a dedicated preview/sandbox origin for user content"
related_components:
  - "packages/app/app/components/viewers/HtmlViewer.vue"
  - "packages/api/server/routes/api/workspaces/[workspaceId]/shares/[shareId].patch.ts"
  - "packages/app/app/utils/htmlScripts.ts"
  - "packages/app/app/composables/useHtmlScriptGrants.ts"
  - "packages/app/app/utils/htmlRefs.ts"
  - "packages/app/app/components/WorkspaceView.vue"
  - "packages/api/server/routes/api/share/[token]/file.get.ts"
tags:
  - untrusted-content
  - iframe-sandbox
  - opaque-origin
  - same-site-cookies
  - trust-boundary
  - prompt-injection
---

## Problem

Workspace HTML renders inert: the preview sandbox omits `allow-scripts`, so a slide
deck with arrow-key controls, or a chart that draws itself, cannot be used at all.
The obvious fix — add `allow-scripts` — is the one change that must never be made,
because the default sandbox grants `allow-same-origin`, and that pair lets the
document script our origin and strip its own sandbox.

## Solution

Scripts are opt-in per file, in a sandbox that trades same-origin away to afford
them: `allow-scripts allow-popups allow-popups-to-escape-sandbox`
(`HTML_SCRIPTS_SANDBOX`). The document lands in an opaque origin. Verified in a
browser, from inside a running page: `origin` is `"null"`, and `document.cookie`,
`localStorage` and `parent.document` each throw `SecurityError`; a credentialed
`fetch` to the API is refused (the CORS allowlist matches exact origins and never
echoes `null`).

Opt-in, not default, because workspace HTML is routinely agent-written and so is
subject to prompt injection. A page carrying executable script offers itself in a
small notice floating over the corner of the preview (never a strip above it —
rendered HTML owns the whole canvas); the same decision is available in the file
top bar's "⋯" menu.

## Remembering the answer, and what unremembers it

Decisions persist per file in `localStorage` (`th:html-scripts`), scoped by
**user and workspace** — a browser is shared, and workspace-only scoping hands
the next account to sign in the previous one's answers about files they have
never seen. Nothing clears this on sign-out, so the key has to do that work.

Each decision names the bytes it was about, with a deliberate asymmetry:

- **An allow is pinned to a SHA-256 of the content it was given to.** "I trust
  this deck" cannot mean "I trust whatever this path holds next week" — an agent
  rewriting the file has to be consented to again. The notice then says so rather
  than silently re-asking.
- **A dismissal is not pinned.** Re-asking after every save would be nagging:
  saying no leaves the page as inert as it already was, so a content check
  protects nothing.

### Why a digest and not the file version

A version is not an identity for bytes, in two ways that both let different
content run under an older grant:

1. **Every newly created node starts at version 1** (`files.ts` — create, restore
   and the resurrection path all do). So a path that is deleted and recreated, or
   that another file is moved onto, presents different content under exactly the
   path-and-version a grant was written for.
2. **The viewer reads the mutable head.** `readFile` fetches whatever is current
   and discards `X-Treehouse-Version`, while the query key carries the version
   from the directory listing — which can be minutes stale. The bytes on screen
   are therefore not guaranteed to be the version the key claims.

Digesting what is actually rendered sidesteps both, and needs no API change. It
also has to fail closed: no digest (no Web Crypto, or the content has not
settled) reads as "unasked", because without knowing which bytes are on screen
there is no grant that can honestly be said to apply.

Detection (`containsExecutableScript`) parses rather than pattern-matches, and
ignores `<script>` tags holding data (`application/ld+json`, templates). Both
matter for the same reason: a prompt that fires on a `<script>` inside a `<pre>`
block, or on a report's JSON-LD, teaches people to click through the prompt that
matters.

### Derive execution; do not watch for it

Whether the frame is executing is a **computed**, not a flag a watcher keeps
up to date. Two bugs came out of getting this wrong, in opposite directions:

- A watcher that only ever switched execution ON could not undo a grant that had
  already matched. A file changed between two page loads ran its new bytes,
  because the tree hydrates from a persisted cache and briefly reports the old
  version.
- A watcher that re-decided, but keyed on the content identity, never re-fired
  when the _session_ resolved — the user id arrives well after first render, and
  until it does the scope is null and every stance reads "unasked". A file with a
  perfectly good grant sat inert forever.

A standing allow depends on the grant store, the signed-in user and the content
identity, and all three settle at their own pace. A computed cannot have an
incomplete dependency list; a watcher can, and did, twice. A separate nullable
`override` ref carries a choice made from the top bar for the bytes on screen —
which is also what keeps that control working when the decision cannot be
persisted.

Neither bug was reachable by a unit test on the stance function, because the
stance function was right both times.

## What dropping same-origin costs

Three things follow from the opaque origin, and all three are load-bearing:

1. **Workspace-relative media breaks.** A sandbox without `allow-same-origin` has a
   null site-for-cookies, so the session cookie (SameSite=Lax, shared across the
   `app.`/`api.` subdomains) is not sent and the file-bytes API answers 401. Only
   self-contained pages work in scripts mode.
2. **Links must leave by a different exit.** The parent cannot attach its click
   handler to `contentDocument`, and the mode deliberately withholds
   `allow-top-navigation-by-user-activation` (an executing page could turn a stray
   click into a redirect to a fake sign-in). Links get `target="_blank"` instead —
   see `HtmlRefContext.linkTarget`. A `_top` link here would be a dead click.
   The exception is `mailto:`, `tel:` and `sms:` (`APP_SCHEME` in `htmlRefs.ts`),
   which get NO target in either mode. They open an app, not a page. In a new tab,
   Arc opens a blank tab and stalls, and the mail app never opens. From the frame
   itself, the click goes straight to the OS handler: both sandboxes allow this
   because they carry `allow-popups`, and it never unloads the frame.
3. **DOMPurify cannot run.** Stripping `<script>` is what it is for. The sandbox is
   the only control in this mode, which is exactly why it grants no same-origin.

## Why there is no CSP on the frame

A policy tight enough to stop exfiltration would have to close every URL-shaped
side channel (`img-src https:` leaks as well as `connect-src`), which also blocks
the CDN-hosted deck frameworks the feature exists to run. The honest bounded claim
is the one worth keeping: the page can send its own bytes to the internet, and can
reach nothing else — not the session, not the workspace, not the app.

## The proper fix, and what blocks it

Serving previews from a dedicated origin would restore same-origin behaviour
safely: media, `fetch`, and storage all work, because "same origin" means the
preview origin, which owns nothing. It needs a **separate registrable domain**, not
a subdomain — prod sets `COOKIE_DOMAIN` with better-auth `crossSubDomainCookies`,
so any `*.trytree.house` origin both receives the session cookie and can set
cookies scoped to the parent domain (cookie tossing). Plus per-workspace origin
isolation (or `worker-src 'none'`, so one page cannot register a service worker
that intercepts every later preview on a shared origin), and short-lived
HMAC-signed cookie-free file URLs for subresources. Deferred as infrastructure
cost, not rejected.

## Public shares: the sharer decides, not the visitor

A public link presents the same page to someone with no account, no history with
the workspace, and no way to judge what is in the file. Asking THEM is the wrong
shape — "This page wants to run JavaScript" mid-presentation is a question a
client cannot answer and should not be handed. So a share carries its own
`allowScripts` flag, set by the member who mints (or later edits) the link, and
the visitor is never prompted: the deck simply works, or it is inert.

Consequences worth knowing:

- **Enabling it is gated like minting a public link** (KTD4): a logged-in cookie
  session only, never an API key. A leaked agent or CLI key must not be able to
  turn a quiet public link into one that runs code in a visitor's browser.
  Turning it back OFF is not gated — taking capability away is always safe.
- **`PATCH /shares/[shareId]` exists so the URL survives the decision.** Someone
  reaches for this when a link is already with a client who reports that the deck
  does not respond; revoke-and-recreate would hand them a different URL to
  re-send. Because that link is already out, enabling there ASKS first, and
  offers pinning to the version on screen as the answer to "this will run
  whatever the file becomes". Turning it off applies immediately — taking a
  capability back needs no ceremony.
- **FILE shares only, and this is a security rule, not a UI simplification.** A
  folder share is the one case where the viewer rewrites references to sibling
  files, and those rewritten URLs carry the share's own token
  (`/api/share/<token>/file?path=…`, and `/s/<token>?p=…` for links). Give that
  document script and you have handed it a bearer token for the entire shared
  subtree, readable straight out of its own DOM and postable anywhere — no CORS
  involved, because sending needs no read. Both create and PATCH refuse
  `allowScripts` on a folder; the UI merely agrees with them.
- **So a shared deck must be self-contained.** A file share sets
  `reachesSiblings: false`, which is exactly why no token reaches its document —
  and also why nothing relative resolves. Inline the CSS and the images.
- **A live link runs whatever the file becomes.** The sharer consents once; the
  workspace keeps writing. Pinning the share to a version is the answer for
  anything going to a client, and the create form says so at the moment of
  choosing.

### Pinning is a creation-time choice, on purpose

A pinned link is made when the link is made, where the person is looking at the
file. `PATCH /shares/[shareId]` changes ONE thing — whether the page may run —
and deliberately cannot pin.

That is a scope decision with a history. "Pin it to what I am looking at, as I
enable it" sounds like a small convenience and is not: it has to answer which
bytes the caller actually saw, what happens if they changed mid-click, and what a
machine credential may do with it. Four separate review findings came out of that
one affordance before it was removed. Creation keeps the guarantee where it can
be honest: when `allowScripts` is set, a pin must name BOTH `pinnedVersion` and
`pinnedContentHash` (a version alone is not an identity — delete-and-recreate
reuses it), and the server derives the hash itself, compares, and answers 409 on
a mismatch rather than substituting whatever is current.

### A failed write is not the same as an unchanged one

Turning a link's scripts on or off is a capability, not a value, so after a
failure there is no honest checkbox to draw: a refusal changed nothing, but a
lost response may have committed on its way out, and showing "off" for a link
that is in fact executing is the outcome worth designing against. The row stops
showing a switch and asks for a reload — the only thing that yields a state we
actually know.

The tempting alternative is to reconcile: refetch, compare, clear the doubt.
Resist it. `refetchQueries` resolves even when the fetch failed, a GET can
overtake a timed-out PATCH that later commits, and proving a mutation's terminal
result needs an operation id the API does not have. That is a distributed-systems
problem, and a share panel is the wrong place to solve it.

### Proving the boundary, rather than skipping it

Nineteen API suites sit behind `describe.skipIf(!serverUp)`, and a skip reads
exactly like a pass — so the cookie-vs-key gate, the folder refusal and the
workspace scoping could all silently stop running. `pnpm --filter api run
test:server` (scripts/test-server-backed.mjs) guards this three ways: a preflight
health check, `REQUIRE_SERVER=1` which `test/env.ts` turns into a failed import
so an individual suite fails rather than skips, and a post-run health check so a
server that dies mid-run cannot skip its way to green. `.github/workflows/
api-tests.yml` runs it on every PR touching api/db/shared.

### The abuse trade, stated plainly

Scripts on a public link raise the phishing ceiling: a convincing fake sign-in
page hosted on our own domain can now capture what is typed into it, where an
inert share could only look the part. Accepted deliberately (2026-09-02), on the
grounds that accounts are paid and traceable, the sandbox still withholds
`allow-forms` and same-origin, and the capability is off unless a member turns it
on per link. If that trade ever stops holding, the levers are: restrict the
feature to paid workspaces, or add a report-abuse affordance to script-enabled
shares.

## Related

Note the deliberate asymmetry with `share/[token]/file.get.ts`, which forces HTML
to download rather than render: that rule protects the API origin, which holds
cookies. Scripts mode is safe for the opposite reason — its origin holds nothing.