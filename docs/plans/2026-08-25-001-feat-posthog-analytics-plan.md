# Add PostHog analytics, session replay, error tracking and surveys to Treehouse

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds. It must be maintained in accordance with `.agent/PLANS.md` at the repository root.

## Purpose / Big Picture

Today Treehouse ships blind. Nobody on the team can answer "how many people got through onboarding this week", "which file operations do agents actually use", "did that deploy start throwing exceptions", or "what was the user doing right before they filed that bug". There is no analytics, no error reporting and no replay anywhere in the repo — a `grep` for `posthog|sentry|analytics|mixpanel` across the source finds nothing but unrelated words in plan documents.

After this change, a Treehouse operator can open PostHog (EU Cloud) and see: which pages and product actions people use, a session replay of any session with **file contents blocked out and file names masked**, JavaScript exceptions from the web app with readable stack traces (source maps uploaded at build time), server-side exceptions from the API, native events from the Mac desktop shell, and marketing-site funnel data gated behind a cookie banner. They can also launch a survey from the PostHog UI and have it appear in the product without shipping any code.

Crucially, they can do all of that **without ever seeing the contents or the names of a user's files**. Treehouse stores people's private documents; encrypting blobs at rest (see `packages/api/server/utils/blob-crypto.ts`) and then streaming file names to an analytics vendor in plaintext would be incoherent. The privacy design in this plan is therefore the load-bearing part, not a footnote.

You can see it working end-to-end by running the app locally with a PostHog key set, opening a file in a workspace, and observing in PostHog that the resulting replay shows the app's chrome (buttons, nav, dialog titles) legibly while the file tree entries and the editor body are unreadable, and that the `$current_url` on every event reads `/w/<workspaceId>/<redacted>` rather than the real file path.

## Definitions

Terms used throughout, defined once so a newcomer needs no other document:

**PostHog** — a product-analytics vendor. We use their EU-hosted cloud at `eu.i.posthog.com` (ingestion) and `eu-assets.i.posthog.com` (static JS assets). A **project public key** (safe to ship to browsers, looks like `phc_...`) identifies the project. A **personal API key** (secret, looks like `phx_...`) is used only at build time to upload source maps.

**posthog-js** — the browser SDK. **posthog-node** — the Node SDK, for servers and Electron's main process.

**Session replay** — PostHog records the DOM as the user interacts, so you can play the session back like a video. It is DOM-based, not pixel-based, which is why text can be selectively masked.

**Masking vs blocking** — two different replay treatments. A **masked** element keeps its size, position and styling but its text is replaced with asterisks; you see that a list has nine rows of varying width, but not what they say. A **blocked** element is replaced entirely by a grey placeholder box; you see a rectangle where the editor was. posthog-js drives these off CSS classes: `ph-mask` masks text (the `maskTextClass` default) and `ph-no-capture` blocks the element (the `blockClass` default). Verified in `node_modules/@posthog/types/dist/posthog-config.d.ts` around line 520 and in `node_modules/@posthog/browser-common/dist/utils/autocapture-utils.js:308`.

**Autocapture** — PostHog's automatic click/input tracking. It records the tag, classes, and by default the _text content_ of the clicked element. In this app that text would frequently be a file name, so we disable text capture globally (`mask_all_text: true`) and attach explicit safe labels with `data-ph-capture-attribute-*` attributes where we want an event to be identifiable.

**Reverse proxy** — serving PostHog's API and assets from our own domain so that ad blockers and network filters (which block `*.posthog.com`) do not silently delete our data. We implement it as a Nitro catch-all route inside the app's own Cloudflare Worker.

**Nitro** — the server framework Nuxt builds on. Both `packages/app` and `packages/marketing` are Nuxt SPAs (`ssr: false`) deployed to Cloudflare Workers, and both still have a working server side: `packages/app/server/routes/.well-known/treehouse.get.ts` is an existing example.

## Progress

- [x] (2026-08-25) Research: confirmed no existing analytics in repo; confirmed `@posthog/nuxt` v1.7.86 exists and read its source; confirmed posthog-js masking/consent/`before_send` API surface against installed typings.
- [x] (2026-08-25) Decisions taken with the product owner: all four surfaces in scope; replay masks user content but keeps chrome readable; cookie banner on marketing only; EU Cloud, new project.
- [x] (2026-08-25) ExecPlan written.
- [x] (2026-08-25) Milestone 1 — App SPA: `/ph/**` proxy route, client plugin, env wiring, inert without a key. Verified against the real PostHog EU endpoints and in a real browser.
- [x] (2026-08-25) Milestone 2 — Privacy hardening: URL redaction (`redactUrl` + `redactEventProperties` in `packages/shared/analytics.ts`, 65 unit tests), replay masking classes on all content components, text-bearing attributes masked, replay policy for public share pages. Verified in a running app against a real seeded workspace.
- [ ] Milestone 2 (remaining) — Confirm the masking in an ACTUAL PostHog replay. Everything above was verified at the DOM level (classes present on the right elements) and at the property level (redaction run through the live SDK), but no replay has been watched, because that needs a real project key. See "Not yet verified" below.
- [x] (2026-08-25) Milestone 3 — Identity (session-watch, so every sign-out path resets), organization groups, and named events captured at the `useTreehouseApi` chokepoint plus route-driven `file_opened` and `search_performed`.
- [x] (2026-08-25) Milestone 4 — `capture_exceptions` + a `vue:error` hook, and build-time source map upload via `posthog-cli`. Verified `pnpm --filter app run build` still exits 0 with no PostHog env set.
- [x] (2026-08-25) Milestone 5 — `packages/api`: fail-quiet posthog-node singleton, Nitro `error` hook (5xx only, redacted path), `file_changed` captured in the file service's `recordChange`, flush on `close`. 6 new tests for `redactApiPath`; all 206 API tests pass.
- [x] (2026-08-25) Milestone 6 — Marketing site with a consent banner. Verified in a browser: 0 requests and 0 storage before answering; Accept starts PostHog through `/ph/`; Reject leaves no cookie and no PostHog storage.
- [x] (2026-08-25) Milestone 7 — Desktop shell: fail-quiet posthog-node, anonymous per-install id, `onboarding_step` hooked at the journal chokepoint, key baked at bundle time, flush on `will-quit`. All 251 desktop tests pass and the bundle builds.
- [x] (2026-08-25) Milestone 8 — `.env.example` for app/marketing/api, `DEPLOYMENT.md` variables, a `docs/solutions/` entry for the masking contract, and analytics entries on the desktop QA checklist.
- [ ] REMAINING — see "Not yet verified". Needs a real PostHog project key: watch an actual replay, confirm ingestion, confirm the share-page replay stop, confirm source-map symbolication, and confirm cross-domain identity between the marketing site and the app.
- [ ] REMAINING — privacy policy. We now send data to a third-party processor, which has to be disclosed regardless of how well it is masked. Needs a human, not an agent.

## Surprises & Discoveries

- Observation: **The official `@posthog/nuxt` module cannot express this app's privacy requirements.** Its `clientConfig` is copied into `nuxt.options.runtimeConfig.public` (`node_modules/@posthog/nuxt/dist/module.mjs`, the `Object.assign` on `runtimeConfig.public`) and read back in the browser via `useRuntimeConfig()`. Nuxt serialises `runtimeConfig.public` to JSON to ship it to the client, so **function-valued options are silently dropped**. Every option we need for URL redaction (`before_send`) and text masking (`session_recording.maskTextFn`) is function-valued.
  Evidence: `dist/runtime/vue-plugin.js` reads `runtimeConfig.public.posthogClientConfig` and spreads it straight into `posthog.init()`.

- Observation: The same module unconditionally calls `addServerPlugin(...)`, which imports `posthog-node` into the Nitro build. For `packages/app` that means bundling a Node analytics SDK into a Cloudflare Worker whose only server route is a static `.well-known` descriptor. Cost with no benefit.
  Evidence: `node_modules/@posthog/nuxt/dist/module.mjs` calls `addServerPlugin` before any conditional; `dist/runtime/nitro-plugin-v2.js` hooks Nitro's `error` event with posthog-node.

- Observation: **File names leak through the URL, not just the DOM.** The app's file route is `packages/app/app/pages/w/[workspaceId]/[...path].vue`, so opening `Finances/2026 Tax Return.md` produces a URL containing that path. posthog-js attaches `$current_url` and `$pathname` to _every_ event (not just pageviews), and the replay recorder stores the URL on rrweb Meta events. DOM masking alone would therefore have leaked exactly the data we set out to protect.

- Observation: `mask_personal_data_properties: true` is **not** a solution for the above. Its documented behaviour is to mask _query parameters_ (`gclid`, `fbclid`, plus anything in `custom_personal_data_properties`). It does not touch the URL path.
  Evidence: `node_modules/@posthog/types/dist/posthog-config.d.ts` — "Mask personal data properties from the current URL… any `email` property in the URL will be masked… `?email=john.doe%40example.com` => `?email=<MASKED>`".

- Observation: rrweb supports an `unmaskTextSelector`, but **posthog-js does not expose it**. `SessionRecordingOptions` in `@posthog/types` has `maskTextClass`, `maskTextSelector`, `maskTextFn`, `blockClass`, `blockSelector` and no unmask counterpart. A "mask everything, then allowlist the chrome back" strategy is therefore not available, which is why this plan uses an explicit opt-out list of content components instead.

- Observation: `sanitize_properties` is deprecated in favour of `before_send`.
  Evidence: `posthog-config.d.ts:1815` — `/** @deprecated - use before_send instead */`.

- Observation: **The `@posthog/nuxt` client config is JSON-only, confirmed by reading the shipped code, not just the docs.** `dist/runtime/vue-plugin.js` does `posthog.init(key, {api_host, ...runtimeConfig.public.posthogClientConfig})`. Anything not JSON-serialisable never arrives.

- Observation: **`unmaskTextSelector` does not exist in posthog-js.** rrweb supports it upstream, but the shipped `SessionRecordingOptions` type has only `maskTextClass`, `maskTextSelector`, `maskTextFn`, `blockClass` and `blockSelector`. A "mask everything, then allow-list the chrome back" strategy is therefore not available — which is why the masking here is an explicit opt-out list applied at chokepoints.
  Evidence: `node_modules/@posthog/types/dist/posthog-config.d.ts:545` is the only `mask*Selector` in the file.

- Observation: **Text-bearing ATTRIBUTES are a second leak channel that CSS-class masking does not close.** rrweb records every attribute verbatim, so `:title="`Actions for ${node.name}`"` in `FileTree.vue` would have put the file name in the replay DOM in plaintext right next to the span we masked. Handled globally with `session_recording.maskAttributeFn` rather than by editing each call site, because an allow-list of "safe" tooltips is a thing we would eventually get wrong.

- Observation: **Looking at a screenshot found a leak that reading the templates did not.** After masking what the template grep turned up, a screenshot of the running app showed the right-hand `FileInfoPanel` rendering the document's own front matter ("title: Welcome to your workspace") in the sidebar — file CONTENT living outside `FileViewer`, so the viewer's `ph-no-capture` did not cover it. The panel's file-name heading and its `Path` row were unmasked for the same reason. This is the CLAUDE.md rule earning its keep: green tests and a clean grep both said done.
  Evidence: DOM audit after the fix reports 2 blocked regions (1490 chars of body, 38 chars of front matter) where there had been 1.

- Observation: The API could not resolve the `db` and `shared` workspace packages in this worktree until a full `pnpm install` recreated `packages/api/node_modules/{db,shared}`. Unrelated to this feature, but it blocks any attempt to run the full stack here.

## Decision Log

- Decision: **Do not use `@posthog/nuxt`; initialise posthog-js from our own Nuxt client plugin.**
  Rationale: the module drops function-valued config through `runtimeConfig.public` (so `before_send` URL redaction would silently not run — a privacy failure that looks like success), and it forces posthog-node into the Cloudflare Worker bundle. We keep the module's one genuinely useful trick — build-time source map upload via `@posthog/cli` — by invoking the CLI from a `nitro:build:public-assets` hook ourselves, which is the same approach PostHog documents for Nuxt ≤3.6.
  Date/Author: 2026-08-25, Claude.

- Decision: **Reverse-proxy PostHog through a Nitro catch-all route at `/ph/**` in each Nuxt app's own Worker.**
  Rationale: same origin as the app, so no CORS and nothing for a tracker blocker to match on; no new infrastructure and no paid managed-proxy add-on; the app already ships server routes so the pattern is proven here. `ui_host` stays `https://eu.posthog.com` so the PostHog toolbar and "open in PostHog" links keep working.
  Date/Author: 2026-08-25, Claude.

- Decision: **File _contents_ are blocked; file _names_ are masked; app chrome stays legible.**
  Rationale: the product owner chose "mask user content, keep chrome readable". Contents (editor body, file preview, search result snippets) carry the highest risk and no diagnostic value, so they get `ph-no-capture` and become grey boxes. Names carry moderate risk but their _shape_ is diagnostically valuable — seeing "the user scanned a nine-item tree, hesitated, then opened the fourth" is most of what a replay is for — so they get `ph-mask` and become asterisks of the right length in the right place.
  Date/Author: 2026-08-25, Claude.

- Decision: **`mask_all_text: true` and `mask_all_element_attributes: true` globally for autocapture, with explicit `data-ph-capture-attribute-action` labels on controls we care about.**
  Rationale: autocapture's default behaviour is to record the text of whatever was clicked, which in a file browser is a file name. Turning text capture off globally is fail-safe: a new component cannot leak by omission. The `data-ph-capture-attribute-*` mechanism (confirmed present in `node_modules/posthog-js/dist/module.js`) gives back per-control identification without exposing user data.
  Date/Author: 2026-08-25, Claude.

- Decision: **No consent banner in the authenticated app; a banner on the marketing site.**
  Rationale: the product owner's call. The marketing site uses `opt_out_capturing_by_default: true` plus `cookieless_mode: 'on_reject'`, so a visitor who never answers is never persisted to; the app initialises normally and offers an opt-out.
  Date/Author: 2026-08-25, Claude.

- Decision: **Everything is inert when `NUXT_PUBLIC_POSTHOG_KEY` is unset.**
  Rationale: local dev, tests, CI and self-hosted Treehouse instances must not need a PostHog account, and no developer should be generating noise in the production project. The plugin returns early and provides a no-op stub so calling code never needs a null check.
  Date/Author: 2026-08-25, Claude.

- Decision: **The `treehouse` CLI and sync daemon (`packages/cli`) are out of scope.**
  Rationale: not requested, and a background daemon that silently phones home is a materially different consent question from a web app. Revisit deliberately if wanted.
  Date/Author: 2026-08-25, Claude.

## Context and Orientation

Treehouse is a pnpm monorepo. The packages this plan touches:

- `packages/app` — the product. Nuxt 4 SPA (`ssr: false`), Tailwind v4, deployed to Cloudflare Workers via the `cloudflare_module` Nitro preset (`packages/app/nuxt.config.ts`, `packages/app/wrangler.jsonc`). Auth is better-auth accessed through `packages/app/app/composables/useAuthClient.ts`, which talks cross-origin to the API. Routes live in `packages/app/app/pages/`; the file-viewing route is `w/[workspaceId]/[...path].vue` and the public share route is `s/[token].vue`.
- `packages/marketing` — the public site. Same stack and deploy target, dev port 3030 (`packages/marketing/nuxt.config.ts`).
- `packages/api` — the Nitro API on Railway (Node runtime). Config in `packages/api/nitro.config.ts`, routes under `packages/api/server/routes/api/`. This is where better-auth, the file service and the MCP server live.
- `packages/desktop` — an Electron shell whose workspace window loads the _remote_ web app with no preload and a sandboxed renderer (`packages/desktop/src/security.ts` documents why). Its main process runs onboarding (`packages/desktop/src/onboarding/`) and the sync daemon (`packages/desktop/src/daemon.ts`).

Tooling is Vite+ (`vp`): `vp check` for typecheck/lint, `vp test` for tests. Dev environments are per-worktree and started with `pnpm dev` (see the README's "Parallel dev envs in git worktrees"); **only start them when you need a running stack.**

A newcomer should read `packages/app/nuxt.config.ts` and `packages/app/server/routes/.well-known/treehouse.get.ts` before starting — they show the app's config conventions and that server routes work in this SPA.

## Prerequisites

Create a PostHog project on **EU Cloud** (`https://eu.posthog.com`). From Project Settings collect:

- the **project public key** (`phc_...`) → `NUXT_PUBLIC_POSTHOG_KEY`
- the **project ID** (a number) → `POSTHOG_PROJECT_ID`, build-time only
- a **personal API key** with source-map write scope (`phx_...`) → `POSTHOG_CLI_TOKEN`, build-time only

In Project Settings also enable **Session replay**, **Error tracking** and **Surveys**.

None of these are needed to _implement_ or _test_ this plan — every milestone must work (inertly) without them — but they are needed to see data arrive.

## Plan of Work

### Milestone 1 — The app sends events to PostHog through our own domain

At the end of this milestone the app initialises posthog-js when a key is configured, all traffic goes to `https://<app-origin>/ph/...` instead of `posthog.com`, and nothing at all happens when no key is configured.

Add dependencies to `packages/app`: `posthog-js` (runtime) and `@posthog/cli` (dev, used in Milestone 4). Run from the repo root:

    pnpm add --filter app posthog-js
    pnpm add --filter app -D @posthog/cli

Create the proxy at `packages/app/server/routes/ph/[...path].ts`. It forwards asset paths (`static/`, `array/`) to `eu-assets.i.posthog.com` and everything else to `eu.i.posthog.com`, preserving the query string, forwarding the client IP as `x-forwarded-for`, stripping hop-by-hop and encoding headers, and passing the body through as raw bytes so gzip'd payloads survive. It must strip the incoming `cookie` header — our session cookie has no business reaching a third party.

Add to `packages/app/nuxt.config.ts` under `runtimeConfig.public`:

    posthog: {
      key: process.env.NUXT_PUBLIC_POSTHOG_KEY || "",
      host: process.env.NUXT_PUBLIC_POSTHOG_HOST || "/ph",
      uiHost: "https://eu.posthog.com",
    },

Note the `||` rather than `??`, matching the existing `apiUrl` convention and its comment: an empty string means "not configured", not "use the empty string".

Create `packages/app/app/plugins/posthog.client.ts`. It reads that config, returns early with a no-op stub when `key` is empty, and otherwise calls `posthog.init()`. The initial configuration for this milestone:

    api_host: config.host,
    ui_host: config.uiHost,
    defaults: "2025-05-24",
    persistence: "localStorage+cookie",
    autocapture: { ... },        // filled in Milestone 2
    mask_all_text: true,
    mask_all_element_attributes: true,
    capture_pageview: "history_change",
    disable_session_recording: false,

The plugin provides `$posthog` so components can call `usePostHog()`. Write that composable at `packages/app/app/composables/usePostHog.ts`; when PostHog is disabled it returns a stub whose `capture`, `identify`, `group` and `reset` are no-ops, so **no caller ever needs a null check** — this is what stops "is analytics on?" branching from spreading through the codebase.

Acceptance: with `NUXT_PUBLIC_POSTHOG_KEY` unset, start the app and confirm the browser makes **zero** requests to any `/ph/` path and the console is clean. Then set a key, reload, and confirm in DevTools' Network tab that requests go to `http://<your-dev-host>/ph/array/<key>/config` and `/ph/i/v0/e/` and return 200. `vp check` passes.

### Milestone 2 — Privacy: redact URLs, block file contents, mask file names

This is the milestone that makes replay safe to turn on. It has three independent parts, and all three are required — any one alone leaves file names visible somewhere.

**Part A — URL redaction.** Create `packages/app/app/utils/analytics.ts` exporting a pure function `redactUrl(url: string): string`. It parses the URL and rewrites the path:

- `/w/:workspaceId/:filePath...` → `/w/:workspaceId/<redacted>` (the workspace id is an opaque identifier, safe and useful to keep; everything after it is a user-authored path)
- `/s/:token...` → `/s/<redacted>` (a share token is a bearer credential — anyone holding it can read the shared file, so it must never be logged)
- `/invite/:token...` → `/invite/<redacted>`, same reasoning
- every other path is passed through unchanged
- the query string and hash are dropped entirely, since nothing in this app puts anything in them that is worth the risk

Because it is a pure function, it gets real unit tests at `packages/app/test/analytics.test.ts` covering each case above plus nested paths, trailing slashes, paths containing encoded characters, and a non-parsing input (must not throw — return a safe constant).

Wire it in the plugin as `before_send`, rewriting `$current_url`, `$pathname`, `$initial_current_url`, `$referrer` and `$initial_referrer` on every outgoing event. Also pass `get_current_url: redactUrl` so replay URL triggers and survey URL conditions match the redacted form rather than the raw one.

**Part B — Replay treatment of content.** Add classes to the components that render user data. Contents get `ph-no-capture` (rendered as a grey box); names get `ph-mask` (rendered as asterisks).

- `packages/app/app/components/FileEditor.vue` — the CodeMirror/Tiptap editor surface: `ph-no-capture`.
- `packages/app/app/components/FileTree.vue` — the text node of each entry: `ph-mask`. Apply it to the label element only, not the row, so icons, indentation, hover and selection states stay visible.
- `packages/app/app/components/WorkspaceView.vue` — the file preview/viewer region and any breadcrumb rendering the path: `ph-no-capture` on the viewer, `ph-mask` on the breadcrumb.
- `packages/app/app/components/ActivityView.vue`, `ChangeEventRow.vue`, `ChangeEventCluster.vue` — these render file names in a feed: `ph-mask`.
- Search input and results, and the `RightPanel`/`DetailsPanel` metadata — `ph-mask`.
- `packages/app/app/components/ShareView.vue` — `ph-no-capture` on the whole shared-content region.

When adding each class, add a short comment naming _why_ (a future reader must not "tidy up" a class that looks decorative). Grep for the classes afterwards to produce the inventory that goes in the docs in Milestone 8.

**Part C — No replay on public share pages.** `packages/app/app/pages/s/[token].vue` is viewed by people who never signed up for Treehouse, looking at content someone else chose to share. Recording them is both the least useful and the most sensitive data we could collect. In the plugin, after init, call `posthog.stopSessionRecording()` when the route matches `/s/`, and start it again on navigation away. Pageviews and errors still capture (redacted), only replay stops.

Acceptance: run the app, sign in, open a workspace containing a file with an obvious name, and drive it. Then in PostHog: open the replay and confirm the editor is a grey box, the tree entries are asterisks, and the sidebar buttons and dialog titles are readable. Open any event and confirm `$current_url` ends in `<redacted>`. Visit a share link and confirm no replay is produced for it. `vp test` passes with the new `analytics.test.ts`.

**Verify this visually — do not sign it off from tests.** Per `CLAUDE.md`, drive the path in a browser (`agent-browser`) and look at the replay in PostHog. A masking class that was applied to the wrong element typecheck-passes and test-passes perfectly while leaking every file name in the product.

### Milestone 3 — Know who and what

Identify the user so sessions join up across devices, and capture the handful of product events that answer the questions in the Purpose section.

In a client plugin or a small composable that runs once the better-auth session resolves (`useAuthClient().useSession()`), call `posthog.identify(user.id, { email, name })` and `posthog.group("organization", organizationId, { name })`. Call `posthog.reset()` on sign-out so the next user on a shared machine starts a new anonymous identity — search `packages/app` for the existing sign-out handler and hook it there. Identity must never be set from a URL or a route param; only from the resolved session.

Capture named events for the moments that matter, each with **no file names or paths in the properties** — use extensions, sizes, counts and booleans instead:

- `workspace_created`, `workspace_opened`
- `file_opened` (properties: `extension`, `bytes`), `file_edited`, `file_uploaded` (`count`, `total_bytes`)
- `share_created` (`kind`: file or folder, `password_protected`: boolean), `share_viewed`
- `api_key_created`, `invite_sent`, `invite_accepted`
- `search_performed` (`result_count`, `query_length` — **never the query itself**)
- `onboarding_step_completed` (`step`)

Add `data-ph-capture-attribute-action="<name>"` to primary controls (new file, upload, share, connect, invite) so autocapture rows remain identifiable despite `mask_all_text: true`.

Acceptance: perform each action in the running app and watch it arrive in PostHog's live event feed with the expected properties and no file names anywhere. Confirm the person in PostHog shows the right email, and that the organization group is populated.

### Milestone 4 — Client error tracking with readable stack traces

Enable exception capture in the plugin's init config (`capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true }`) and register a `vue:error` hook that forwards to `posthog.captureException(error, { info })` — this is the one genuinely good idea in `@posthog/nuxt`'s client plugin and is three lines to reproduce.

Minified stack traces are close to useless, so upload source maps at build time. In `packages/app/nuxt.config.ts` set `sourcemap: { client: "hidden" }` ("hidden" generates the maps but emits no `//# sourceMappingURL` comment, so they are not discoverable by users) and add a `nitro:build:public-assets` hook that shells out to the `posthog-cli` binary:

    posthog-cli sourcemap inject --directory .output/public --ignore '**/node_modules/**'
    posthog-cli sourcemap upload --directory .output/public --delete-after

with `POSTHOG_CLI_HOST=https://eu.posthog.com`, `POSTHOG_CLI_PROJECT_ID` and `POSTHOG_CLI_API_KEY` in the environment. **The hook must no-op — not fail the build — when `POSTHOG_CLI_TOKEN` is absent**, so local builds and contributor CI keep working. `--delete-after` is important: it removes the `.map` files from the deployed output so we are not serving our own source publicly.

Add an error-tracking suppression for noise that is not ours: browser-extension frames and `ResizeObserver loop limit exceeded`.

Acceptance: temporarily throw from a component, load the app, and confirm the exception appears in PostHog Error Tracking. After a production build with the CLI token set, confirm the stack frames name real `.vue` files and line numbers rather than `chunk-a1b2c3.js:1:48210`. Then confirm `pnpm --filter app run build` still succeeds with `POSTHOG_CLI_TOKEN` unset.

### Milestone 5 — Server-side errors and events from the API

`packages/api` runs on Node on Railway, so `posthog-node` is straightforward here (unlike the Cloudflare-hosted SPAs).

    pnpm add --filter api posthog-node

Add `packages/api/server/utils/analytics.ts` exporting `usePostHog()`, returning a lazily-constructed singleton `PostHog` client configured from `POSTHOG_KEY` and `POSTHOG_HOST` (default `https://eu.i.posthog.com`), or a no-op stub when unset — same fail-quiet contract as the browser side. Set `flushAt`/`flushInterval` modestly (e.g. 20 / 10000) so a burst of events does not become a burst of HTTP requests on a request-handling process.

Add `packages/api/server/plugins/posthog.ts` (a Nitro plugin) that hooks `error` and calls `captureException`, attaching the request path and method but **never** the request body, query string or `Authorization`/`Cookie` headers. Note that this API's paths embed file paths (`/api/workspaces/:id/files/:path`), so reuse a server-side equivalent of `redactUrl` — put the shared logic somewhere both packages can import from (`packages/shared`) rather than writing it twice, since two copies will diverge and one of them will be the leaky one.

Capture a small number of server-authoritative events that the client cannot see honestly: `agent_file_write` and `agent_file_read` from the MCP path (distinct-id the workspace, property `actor_type` from the API key metadata — this is the change-feed attribution model already described in `CLAUDE.md`), and `workspace_created` server-side as the source of truth.

Ensure `posthog.shutdown()` is called on Nitro's `close` hook so buffered events are not lost on redeploy.

Acceptance: with a key set, cause a 500 in a route and confirm the exception lands in PostHog with the redacted path. Perform an MCP file write with an agent API key and confirm `agent_file_write` arrives with `actor_type: "agent"`. Confirm the API boots and serves normally with no PostHog env set. `vp check` and `vp test` pass.

### Milestone 6 — Marketing site with a cookie banner

`packages/marketing` gets the same proxy route and a client plugin, but with consent gating: `opt_out_capturing_by_default: true` and `cookieless_mode: "on_reject"`. Nothing is persisted and no events are sent until the visitor accepts.

Build a `CookieBanner.vue` following `design.md` and the brand reference at `/brand` — this is a public-facing surface on a cream-and-green site and a default-styled grey bar will look wrong. It offers Accept and Reject, stores the choice in `localStorage`, and never reappears once answered. Accept calls `posthog.opt_in_capturing()`; Reject leaves the SDK opted out (with `cookieless_mode: "on_reject"`, PostHog then counts the visit without identifying storage).

Because the marketing site and the app are different origins (`trytree.house` and `app.trytree.house`), a visitor's marketing session will not automatically join to their app session. Link the two by appending PostHog's cross-domain parameter to the CTA links that point at the app — set `cross_subdomain_cookie` appropriately and verify the joined funnel actually works rather than assuming it does.

Acceptance: load the marketing site fresh (clear storage), confirm **no** `/ph/` requests before answering the banner. Accept, confirm the pageview arrives. Clear storage, reload, Reject, confirm no identifying cookie is set. Click through to the app and confirm in PostHog that the marketing visit and the app session belong to the same person.

### Milestone 7 — Desktop shell events

Add `posthog-node` to `packages/desktop` and a small `src/analytics.ts` exporting the same fail-quiet singleton, keyed off a build-time-baked key (alongside `TREEHOUSE_APP_VERSION` in `scripts/build.mjs`).

The workspace window loads the remote web app, so the SPA's own PostHog already covers everything inside it. This milestone is only about the **native shell**, which is otherwise invisible: onboarding funnel steps from `src/onboarding/machine.ts`, sync daemon start/stop/crash from `src/daemon.ts`, update installs from `src/updater.ts`, and the tray/native paths the web app cannot see.

Use a stable per-install anonymous id persisted alongside the existing app config, and once the user signs in, alias it to their user id so the desktop and web identities join. Register `$app_version` (from `SHELL_VERSION`) and platform as super properties. **Never** send folder paths — the local sync folder path contains the user's name on macOS (`/Users/<name>/...`). Send a boolean or a hash if you need to distinguish folders.

Acceptance: run the shell in dev per `docs/desktop/testing-onboarding-locally.md`, complete onboarding, and confirm the step events arrive with no filesystem paths in any property.

### Milestone 8 — Documentation and operational hygiene

Add the new variables to every `.env.example` that needs them, with comments in the established house style (the existing files explain _why_, not just _what_ — match that):

- `packages/app/.env.example` and `packages/marketing/.env.example`: `NUXT_PUBLIC_POSTHOG_KEY`, `NUXT_PUBLIC_POSTHOG_HOST`, plus build-time `POSTHOG_CLI_TOKEN` and `POSTHOG_PROJECT_ID` with a note that they are only needed for source-map upload.
- `packages/api/.env.example`: `POSTHOG_KEY`, `POSTHOG_HOST`.

Write `docs/solutions/` entries capturing the two findings a future contributor will otherwise rediscover the hard way: (1) why we do not use `@posthog/nuxt` (function config is dropped through `runtimeConfig.public`), and (2) the masking contract — the list of components carrying `ph-mask`/`ph-no-capture`, and the rule that any new component rendering file names or contents must carry one.

Add to `docs/desktop/qa-checklist.md` the replay checks that CDP cannot make for us.

Update `DEPLOYMENT.md` with the production env vars for Railway (API) and Cloudflare (app, marketing).

Finally, add the privacy posture to the user-facing privacy policy — we are now sending data to a third-party processor, and that has to be disclosed regardless of how well it is masked. Flag this to the product owner as a task that needs a human, not an agent.

## Validation

Run from the repo root at every stopping point:

    vp check
    vp test

For the runtime behaviour, start only what you need (`pnpm dev:api` for API work, `pnpm dev` for the full stack) and stop it when finished. The acceptance criteria in each milestone above describe what to observe; the masking behaviour in Milestone 2 in particular must be confirmed by _looking at a real replay in PostHog_, not by reading the code.

- Observation: **A fourth leak channel, found only by recording a real session and searching the bytes.** With the DOM audit clean and every event property redacted, `rrweb`'s `Meta` event still carried the full page href, and the `FileInfoPanel` download link still carried `href="/api/workspaces/:id/files/README.md"` and `download="README.md"`. posthog-js does not run replay URLs through `before_send` — it uses `_maskUrl`, which consults `session_recording.maskCapturedNetworkRequestFn`/`maskNetworkRequestFn` and **returns the URL unchanged when neither is set**. Fixed with `maskCapturedNetworkRequestFn` plus `href`/`src` handling in `maskAttributeFn`, and by teaching the shared `redactUrl` the API's route shapes.
  Evidence: minified posthog-js `_maskUrl(e){var t=this._instance.config.session_recording;if(t.maskCapturedNetworkRequestFn){…}if(t.maskNetworkRequestFn){…}return e}`. Before the fix, a text search of the recorded payload found `README.md` three times; after, zero, with chrome strings still present.

- Observation: **`download` must NOT be redacted as a URL.** `<a download="2026 Tax Return.md">` is a bare filename; `redactUrl` parses it as a relative path and returns `/2026 Tax Return.md` — leaking the exact value being protected. It is masked as text; only `href`/`src`/`action` get `redactUrl`.

- Observation: **posthog-js drops events from headless browsers by default.** `opt_out_useragent_filter` defaults to `false`, so its bot filter matched `HeadlessChrome/150` and silently discarded every `capture()` call — which is why no capture request ever appeared in any browser test. Correct production behaviour, but it means client-side ingestion cannot be observed from a headless driver without a spoofed UA. `set_config` does not re-evaluate it; the check is cached at init.

- Observation: **Three of the four requested features are disabled in the PostHog project itself.** The project's remote config reports `sessionRecording: false`, `surveys: false`, `errorTracking.autocaptureExceptions: false`. The SDK loads and events ingest fine, but replay, surveys and error autocapture will not start until those are toggled on in Project Settings. Nothing in this repo can enable them.

- Observation: **A fifth leak channel — the console.** rrweb records `console.*` arguments verbatim, no DOM masking applies, and whether it records them is a PostHog PROJECT setting (`consoleLogRecordingEnabled: true` on this project), not something the repo controls. `plugins/vue-query.client.ts` logs a cache-restore failure, and vue-query cache keys are `["file-text", workspaceId, path, version]` — a failed restore would put a file path into a replay. Closed with `enable_recording_console_log: false`.

- Observation: **Stopping replay in `afterEach` is too late.** The router hook fired correctly on `/s/`, but `afterEach` runs once the incoming route has RENDERED, so rrweb captured the share page before the stop. Measured at the proxy: 1 replay POST / 937 bytes while sitting on a public share page. Moving the stop to `beforeEach` (start stays in `afterEach`) took it to 0 POSTs / 0 bytes.

- Observation: **posthog-js drops everything from automated browsers**, because its bot check reads `navigator.webdriver`. Spoofing the user agent does not help. `capture()` returns normally and nothing is ever sent — which is why no browser test ever showed capture traffic. `set_config({opt_out_useragent_filter: true})` re-enables it for a test run.

- Observation: **In-page network hooks cannot observe PostHog.** It caches `window.fetch` at module-evaluation time, so later patches to `fetch`/`XHR`/`sendBeacon` see nothing; `performance.getEntriesByType` misses the keepalive sends; and replay payloads are compressed, so marker-string searches fail. The reliable method is a temporary counter in our own `/ph` proxy plus a debug route — `s` is replay traffic, `i/v0/e` is events.

## Not yet verified

Stated plainly so nobody mistakes this for finished:

- **Ingestion is confirmed.** A properly-formed event POSTed through our own `/ph` proxy with the real project key returned `{"status":"Ok"}` / HTTP 200 (`verification_probe`, distinct id `claude-code-setup-check`).
- **Replay masking is confirmed against the recorded bytes, not the replay UI.** `rrwebRecord` was driven with the live `session_recording` config read off the running posthog instance, on a real file page; the serialised payload contains no file name, no file content, and no file URL, while chrome strings ("New file", "Refresh", "Version") remain. Stylesheet and `/_nuxt/` asset URLs survive, so replays still render.
- **Session replay now runs end to end.** With replay enabled on the project, the recorder reaches `active`, loads `posthog-recorder.js` through our proxy, and POSTed 305KB across 23 requests for a real browsing session. Replay URL for that session: `https://eu.posthog.com/project/.../replay/01a03cbd-772f-74ae-bf21-4681a11d8ef3`.
- **The share-page replay stop is now verified at the network level**: 2 POSTs / 3.5KB in the workspace, **0 POSTs / 0 bytes** on `/s/:token`, 2 POSTs / 85KB on return (a fresh full snapshot). This is what surfaced the `afterEach` → `beforeEach` fix.
- **Error tracking verified** — `captureException` produced an event POST with the project's `autocaptureExceptions: true`.
- **Surveys verified as working** — `getActiveMatchingSurveys` responds and `surveys.js` loads through the proxy; it returns 0 because no surveys have been created yet. (`surveys: false` in remote config means "none defined", not "disabled".)
- **NOT watched in the replay player by a human.** The masking is verified against the recorded bytes, which is stricter in some ways, but nobody has opened the replay above and looked at it.
- **Source-map symbolication is unverified** — needs `POSTHOG_CLI_TOKEN` (a personal API key) and `POSTHOG_PROJECT_ID`, which were not supplied.
- **Cross-domain identity** between the marketing site and the app is unverified.

## Outcomes & Retrospective

To be written at completion.