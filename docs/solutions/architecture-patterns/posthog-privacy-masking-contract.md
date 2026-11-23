---
title: PostHog in Treehouse — the file-privacy masking contract, and why the official Nuxt module is not used
module: app
date: 2026-08-25
problem_type: architecture_pattern
component: analytics
severity: high
applies_when:
  - "adding a component that renders a file name, folder name, path, or file contents"
  - "adding a route to packages/app, or changing an existing route's shape"
  - "changing anything in app/plugins/posthog.client.ts or packages/shared/analytics.ts"
  - "considering adopting @posthog/nuxt, or wondering why it isn't already used"
  - "adding analytics to a new surface (a new Nuxt app, a new server)"
related_components:
  - packages/app/app/plugins/posthog.client.ts
  - packages/shared/analytics.ts
  - packages/api/server/utils/analytics.ts
  - packages/marketing/app/plugins/posthog.client.ts
---

# PostHog in Treehouse: the privacy contract

Treehouse stores people's private documents and encrypts their bytes at rest
(`packages/blob-io/src/blob-crypto.ts`). Sending those documents' names or
contents to an analytics vendor would make that encryption theatre. Analytics
here is therefore built around one rule:

> **PostHog may know the shape of what someone did. It may never know what their
> files are called or what is in them.**

Everything below exists to hold that line. If you are adding a component or a
route, the section you need is "What you must do".

## Six leak channels, not one

The mistake to avoid is thinking this is a session-replay problem. It is six
separate problems, and closing any one alone leaves the data exposed. Channel 4
was found only by recording a real session and text-searching the payload —
after the first three were closed and the DOM audit looked clean:

**1. The URL.** The app's file route is `app/pages/w/[workspaceId]/[...path].vue`
— the file path _is_ the URL. posthog-js attaches `$current_url` and `$pathname`
to **every** event it sends: pageviews, autocapture clicks, exceptions, replay
metadata. So even with a perfectly masked DOM, every click would have shipped the
file name in a property nobody thinks to look at.

Closed by `redactUrl` / `redactEventProperties` in `packages/shared/analytics.ts`,
wired in as posthog-js's `before_send`. `/w/:id/Finances/Tax.md` becomes
`/w/:id/<redacted>`; share and invite tokens (which are bearer credentials — whoever
holds one can read the content) become `<redacted>`; query strings and hashes are
dropped wholesale.

Note that `mask_personal_data_properties: true` does **not** help here. Despite the
name, it only masks query _parameters_ (`gclid`, `fbclid`, and anything you add to
`custom_personal_data_properties`). It never touches the path.

**2. The DOM, in session replay.** Two treatments, applied via CSS classes:

- `.ph-no-capture` → the element becomes a grey box. Used for file **contents**.
- `.ph-mask` → the text becomes asterisks, layout preserved. Used for file **names**.

Names are masked rather than blocked on purpose: "the user scanned a nine-item
tree, hesitated, then opened the fourth" is most of what a replay is _for_, and
it costs nothing to know.

**3. Attributes.** rrweb records every DOM attribute verbatim. `FileTree.vue` had
`:title="`Actions for ${node.name}`"` — which would have sat in the replay in
plaintext right beside the span we so carefully masked. Closed globally with
`session_recording.maskAttributeFn`, which blanks `title`, `aria-label`, `alt`,
`placeholder` and `value` everywhere. An allow-list of "safe" tooltips is a thing
we would eventually get wrong, in the direction that leaks.

**4. The replay's own URL records.** This one is invisible from the DOM and from
event properties, and it is the easiest to miss. rrweb's `Meta` event carries the
page `href`; posthog-js also writes `$url_changed` and `$pageview` custom events
_inside_ the recording; and network-request capture records every request URL —
including `/api/workspaces/:id/files/<the user's path>`.

**None of that goes through `before_send`.** posthog-js routes it through
`_maskUrl`, which consults `session_recording.maskCapturedNetworkRequestFn` (or
the older `maskNetworkRequestFn`) and, if neither is configured, **returns the
URL completely unchanged**. So the replay's own address bar would have shown the
full file path while every event property around it was correctly redacted.

Closed with `maskCapturedNetworkRequestFn` running `redactUrl` over the request
name. This is why `redactUrl` in `packages/shared/analytics.ts` also knows the
**API's** route shapes (`/api/workspaces/:id/{files,list,search}/…`,
`/api/share/:token`, `/api/invites/:token`) even though it lives in code the
browser runs: the browser emits API URLs too.

URL masking does not make a captured request body or header safe. PostHog can
enable both through remote project settings, so the app also sets
`session_recording.recordBody: false` and `recordHeaders: false` explicitly.
Those local `false` values override the remote settings and keep file bytes,
API keys and other credentials out of replay network records.

There is a related DOM case in the same family — the download button in
`FileInfoPanel` renders `href="/api/workspaces/:id/files/2026 Tax Return.md"`
and `download="2026 Tax Return.md"`. `maskAttributeFn` handles both, but note
they need _different_ treatment: `href` is a URL and gets `redactUrl` (so
stylesheet and `/_nuxt/` asset URLs survive and the replay still renders with
our real CSS), while `download` is a bare **filename** — running it through
`redactUrl` would parse it as a relative path and hand back `/2026 Tax Return.md`,
leaking the exact thing being redacted. It is masked as text instead.

**5. The console.** rrweb records `console.*` **arguments verbatim**, and no DOM
masking touches them. Worse, whether they are recorded is a **PostHog project
setting** (`consoleLogRecordingEnabled`), not something this repo controls — so
leaving it to the default makes the privacy posture depend on a toggle in
someone's account.

This app logs `console.warn("Treehouse: query cache restore failed", e)` from
`plugins/vue-query.client.ts`, and its vue-query cache keys are
`["file-text", workspaceId, path, version]` — so a failed cache restore can put a
file path straight into a replay. Closed by setting
`enable_recording_console_log: false` explicitly in the client config. Exceptions
are not lost: error tracking captures them separately, with stack traces.

**6. The `Referer` header — created by the proxy itself.** The nastiest of the
six, because the fix for one problem caused it. Serving PostHog **same-origin**
at `/ph` means the browser attaches the **full page URL** as `Referer` on every
request to it: the default `strict-origin-when-cross-origin` policy only trims
the path when the origin differs, and here it does not. So
`/w/:id/Finances/2026 Tax Return.md` rode along on every event, every flag poll
and every replay chunk.

It is invisible from the payload, so no amount of `before_send` redaction
touches it, and it was verified only by logging what the proxy actually
forwarded. Closed by adding `referer` to the proxy's dropped-header list.
Dropped rather than redacted: PostHog has no use for it and derives `$referrer`
from the event body, which is redacted already.

Separately, autocapture runs with `mask_all_text: true` and
`mask_all_element_attributes: true`, because autocapture records the text of
whatever was clicked — which in a file browser is a file name. This is
**fail-safe**: a new component cannot leak by forgetting to opt out. Where a
control needs to be identifiable in autocapture, give it an explicit safe label
with `data-ph-capture-attribute-action="…"`.

## What must SURVIVE redaction: marketing attribution

Privacy and attribution pull in opposite directions here, and it is easy to
over-redact and quietly destroy acquisition reporting. Two things are commonly
confused:

**The HTTP `Referer` header** (dropped at the proxy, channel 6) is _not_ the
attribution referrer. Because `/ph` is same-origin, that header is the page the
user is currently on **in our own app** — `/w/:id/Secret.md`, never
`news.ycombinator.com`. Dropping it costs nothing.

**The `$referrer` event property** is the attribution one. posthog-js reads
`document.referrer` and puts it in the payload; PostHog derives acquisition
reporting from that and from campaign properties, not from the HTTP header.

So the redaction rule deliberately **keeps**:

- `$referring_domain`, `$session_entry_referring_domain` — a bare domain, no path
- `$session_entry_utm_source` / `_medium` / `_campaign` / `_term` / `_content`
- `$session_entry_gclid` and the other click ids
- the domain **and path** of external referrers, so `twitter.com/pixelhop/status/123`
  survives intact — knowing which post sent someone is the point

and **redacts** anything whose property name ends in `url`, `pathname` or
`referrer`, because those carry our own paths. That is a name-_shape_ rule, not
a list, because an exact list is fail-open: `$session_entry_url` and
`$session_entry_pathname` were missed by the original list, and they carry the
page a session STARTED on — so anyone deep-linking, bookmarking, or refreshing
while a file was open put that path on **every event for the rest of the
session**. The rule now catches whatever `$..._url` PostHog invents next.

`packages/shared/test/analytics.test.ts` pins both directions. If you tighten
the rule, the attribution tests will tell you what you broke.

Note the marketing site applies **no** redaction at all — it renders public
copy and has no user content — so acquisition tracking there is untouched.

## Where the classes live

Applied at chokepoints rather than scattered, so one class covers many render
sites:

| File                                                                                               | Class                       | Covers                                                               |
| -------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `FileViewer.vue`                                                                                   | `ph-no-capture`             | all five viewers (markdown, html, code, image, binary)               |
| `FileEditor.vue`                                                                                   | `ph-no-capture` + `ph-mask` | the live editor body; the path in its toolbar                        |
| `FileInfoPanel.vue`                                                                                | `ph-no-capture` + `ph-mask` | front matter, historical-version contents and names, metadata values |
| `CommentsPanel.vue`                                                                                | `ph-no-capture`             | document quotes, historical context, drafts and comment bodies       |
| `FileLink.vue`                                                                                     | `ph-mask`                   | file names in the activity feed and anywhere else linking a file     |
| `FileTree.vue`                                                                                     | `ph-mask`                   | tree entry labels, context-menu header                               |
| `FileSearchResults.vue`                                                                            | `ph-mask`                   | result names, parent paths, and the query echoed in highlights       |
| `PathBreadcrumb.vue`                                                                               | `ph-mask`                   | crumb segments (slashes stay visible, so the path's shape survives)  |
| `FolderView.vue`, `CalendarView.vue`, `FolderInfoPanel.vue`, `MoveNodeDialog.vue`, `FileShare.vue` | `ph-mask`                   | folder listings, calendar headings/chips/notices, folder name/path   |
| `NodeIconDialog.vue`, `WorkspaceView.vue`, `ShareView.vue`, `LocalFolderSection.vue`               | `ph-mask`                   | dialog names, missing paths, default-page tabs, local folder data    |

`ph-mask` is **inherited by descendants** (rrweb resolves it by walking
ancestors), so putting it on a wrapper covers the text inside it.

## What you must do

- **Rendering a file or folder name?** Put `ph-mask` on the element and a comment
  saying why, so nobody "tidies up" a class that looks decorative.
- **Rendering file contents?** `ph-no-capture`. Note this includes front matter —
  the document's own title and tags are content, and `FileInfoPanel` renders them
  in the sidebar, _outside_ `FileViewer`, which is exactly the leak a screenshot
  caught after the templates had already been swept.
- **Adding a route with user data in the path?** Add a case to `redactSegments`
  in `packages/shared/analytics.ts` and a test in `packages/shared/test/analytics.test.ts`.
  A new route leaks silently by default.
- **Capturing an event?** Extensions, byte counts, booleans and result counts.
  Never a name, a path, a search query, or a token. `search_performed` sends
  `result_count` and `query_length`, never the query.
- **Deriving the extension? Use `fileExtension()` from `packages/shared`.** It
  took three goes to get right, and each failure leaked:
  1. `path.lastIndexOf(".")` searches the WHOLE path, so
     `Private.secret/Tax Return` reported `secret/tax return` — folder and file
     name. Fixed by taking the basename first.
  2. A dot inside the basename still leaked: `Report v1.2 final` -> `2 final`.
     Fixed by requiring a short alphanumeric tail.
  3. That shape check is a **deny-list in disguise, and fail-open**: it happily
     forwarded `Diagnosis.HIV`, `Client.Acme` and `Salary.Bob`. A dot does not
     mean a file type follows it. Fixed by requiring the tail to be on an
     explicit **allow-list** of known formats; everything else is `"other"`.

  Extending `KNOWN_EXTENSIONS` is fine — a file format is not information about
  a person. Just check that what you are adding is genuinely a format, and not
  something a user might plausibly type after a dot.

- **Verify by looking, then verify by recording.** A masking class on the wrong
  element typechecks and passes tests perfectly while leaking every file name in
  the product. Run the app, open a file, and audit the DOM:
  `[...document.querySelectorAll(".ph-mask, .ph-no-capture")]`.

  Then go further, because the DOM audit is what missed channel 4. Load
  `/ph/static/<version>/recorder.js`, drive `rrwebRecord` with the **live**
  `session_recording` config read off the running posthog instance (not retyped,
  so it cannot drift from what ships), serialise the emitted events, and text-
  search the payload for a file name and a sentence from the file body. They must
  be absent; chrome strings like "New file" and "Refresh" must still be present.
  That searches the actual recording bytes, which is stricter than watching the
  replay UI — and it works even when session replay is disabled in the PostHog
  project, because it never involves PostHog's servers at all.

## Testing against a live PostHog project

Two things will waste an afternoon if you do not know them up front:

**posthog-js drops everything from automated browsers.** Its bot filter checks
`navigator.webdriver`, which is `true` in every driven browser — so `capture()`
appears to work while nothing is ever sent, and spoofing the user agent does not
help. For a test run only, `posthog.set_config({ opt_out_useragent_filter: true })`
re-enables sending. Never change this in shipped config; filtering bots is
correct.

**In-page network hooks cannot see PostHog's traffic.** posthog-js caches
`window.fetch` at module-evaluation time, so patching `fetch`, `XMLHttpRequest`
or `sendBeacon` afterwards observes nothing, and `performance.getEntriesByType`
misses the keepalive sends. Replay payloads are also compressed, so searching
them for a marker string fails even when you do capture them. The reliable
approach is to observe at our own `/ph` proxy: add a temporary module-level
array in `server/routes/ph/[...path].ts` plus a debug route that returns it, and
count POSTs by path — `s` is session replay, `i/v0/e` is events. Remove the
scaffolding before committing.

## Why not `@posthog/nuxt`

There _is_ an official Nuxt module, and it is the obvious thing to reach for. It
cannot express this privacy design, for two independent reasons:

1. **Function config is silently dropped.** The module copies its `clientConfig`
   into `nuxt.options.runtimeConfig.public` and the browser plugin reads it back
   with `useRuntimeConfig()`. Nuxt serialises `runtimeConfig.public` to JSON to
   ship it to the client, so every function-valued option vanishes — including
   `before_send`, which is the _only_ thing keeping file paths out of
   `$current_url`. The module would have looked like it worked while leaking
   every file name in the product. That is the worst possible failure mode: no
   error, no warning, correct-looking dashboards.
2. **It forces `posthog-node` into the Cloudflare Worker.** The module calls
   `addServerPlugin` unconditionally. `packages/app` is an SSR-disabled SPA whose
   only server route is a static `.well-known` descriptor; a Node analytics SDK
   in that bundle is cost with no benefit.

We keep the one genuinely useful thing the module does — build-time source map
upload via `@posthog/cli` — as a `nitro:build:public-assets` hook in
`packages/app/nuxt.config.ts`. That hook **no-ops without credentials and never
fails the build**, so contributors and CI without a PostHog account are fine.

Related: rrweb supports an `unmaskTextSelector`, but **posthog-js does not expose
it**. A "mask everything, then allow-list the chrome back" strategy is therefore
not available — which is why this is an explicit opt-out list at chokepoints.

## Consent differs by surface

- **`packages/app`** initialises on load. These people have an account and a
  contract with us. Session replay is stopped entirely on `/s/:token` public
  share pages — and the stop happens in the router's **`beforeEach`**, not
  `afterEach`. That asymmetry is load-bearing: `afterEach` runs once the incoming
  route has rendered, which leaves rrweb a window in which the share page is
  already on screen. Measured at the proxy, that window was worth ~1KB of replay
  data POSTed while sitting on a public share page. Stopping in `beforeEach`
  takes it to zero. Starting stays in `afterEach`, so recording resumes once the
  product page is actually up.
- **`packages/marketing`** does not initialise _at all_ until the visitor accepts
  the banner. Note that `opt_out_capturing_by_default` is deliberately **not**
  used: it suppresses event capture but still initialises the SDK, loads its
  bundles and calls `/flags`. Measured in a browser, that was four requests
  before the banner was touched — so it contradicts a banner that says "no
  tracking until you say so". The cost of the stricter approach is that rejected
  visits go entirely uncounted.

## The proxy

Both Nuxt apps serve PostHog from their own origin at `/ph/**`
(`server/routes/ph/[...path].ts`), because `*.posthog.com` is blocked by most
tracker blockers and many corporate networks. That failure is silent — the app
works, nothing errors, and the data for that slice of users simply never
arrives, which is worse than no analytics because the numbers still look
plausible. The proxy also strips two headers on the way out. `cookie`, because our
better-auth session cookie has no business reaching a third party. And
`referer`, because same-origin requests carry the full page URL — see channel 6.
**Any new header added to the forward list needs the same question asked of it:
does this carry the URL, or anything derived from it?**