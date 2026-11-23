---
date: 2026-08-05
status: active
type: feat
---

# feat: Agentic workspace bootstrap

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

The requirements for this document's form and maintenance are in `.agent/PLANS.md` at the repository root. Maintain this document in accordance with that file.

## Purpose / Big Picture

Today a brand-new Treehouse workspace is completely empty. A person signs up, the system creates an organisation and a workspace named "Default", they connect the desktop app or the CLI, and they are looking at an empty folder with a sidebar that says "No files yet. Drop files here, or connect an agent or the CLI." Nothing tells them what to put in it, and nothing tells their agent what this place is for. The blank page is the hardest moment in the product, and right now the product says nothing at that moment.

After this change, every newly created workspace contains two files: a `README.md` written for the human, and an `AGENTS.md` written for their coding agent. The `README.md` renders as the workspace's front page in the web app and tells the person the single next thing to do. The `AGENTS.md` is a setup guide addressed to an agent: it tells the agent to interview the person about what this workspace is for, to propose a folder structure from a set of named starting templates, to create that structure once the person approves it, and then — for a company or client workspace — to go and research the person's website and public profiles and draft an initial knowledge base of brand, product, and tone-of-voice notes. When the bootstrap finishes, the guide instructs the agent to retire itself: it rewrites `README.md` into a real front page for the workspace that now exists, and replaces `AGENTS.md` with conventions specific to that workspace. The setup instructions do not linger at the root forever.

The observable outcome a human can verify: sign up for a fresh account, connect a folder with the desktop app or the CLI, open that folder in Claude Code, and type "set up this workspace". The agent asks what the workspace is for, proposes a structure, creates it on approval, offers to research a website, and writes draft brand notes marked as unverified. Refresh the web app and the new folders and files are there, with the workspace's `README.md` rewritten as its front page.

Treehouse itself runs no language model to make this happen. It only seeds two markdown files. All of the intelligence lives in the person's own agent, which is the point: the product's design test is "could Claude Code run it perfectly?", and a bootstrap that requires Treehouse-hosted inference would fail that test, cost money per signup, and be impossible for a self-hoster to reproduce.

## Progress

- [x] (2026-08-05) Researched the existing surface: workspace creation sites, the file service write path, the MCP server instructions, the CLI ignore rules, and the folder-default-page convention. Findings recorded in `Context and Orientation`.
- [x] (2026-08-05) Settled the three architectural forks with the user: the person's own agent runs the interview; the kit is a root `README.md` plus a root `AGENTS.md`; the folder structures ship as named templates the agent picks from. Recorded in `Decision Log`.
- [x] (2026-08-05) Milestone 1 — Seed on creation. `packages/api/server/utils/seed.ts` wired into all four creation sites; `packages/api/test/seed.test.ts` (8 tests) plus a sign-up assertion in `packages/api/test/auth-api-key.test.ts`. `TREEHOUSE_SEED=0` escape hatch documented in `packages/api/.env.example`.
- [x] (2026-08-05) Milestone 2 — Kit content authored in `packages/api/server/utils/seed-content.ts`. Written directly rather than via the placeholder step the plan described; the placeholder round would have been thrown away.
- [x] (2026-08-05) Milestone 3 — MCP server instructions point at `AGENTS.md`; `SERVER_INSTRUCTIONS` exported so the paragraph is test-pinned.
- [x] (2026-08-05) Milestone 5 — Agent hand-off CTAs. `packages/app/app/utils/setupPrompt.ts` builds one prompt and three deep links; `WorkspaceSetupCard.vue` renders them at the workspace root while `needsSetup()` holds; `packages/app/test/setupPrompt.test.ts` covers prompt/link/visibility. Verified in a browser: card renders, links encode correctly, prompt reveals, copy works, and the card disappears the moment a folder is created. Added after the original plan (see `Decision Log`).
- [x] (2026-08-06) Milestone 4 — Verify by using it. **Done, including the cold-agent run.** A fresh subagent with no knowledge of how the guide was written was given only "Set up this workspace." in a real CLI-synced folder; a human played the owner of ryeandbeyondcottages.co.uk. Full result in `Outcomes & Retrospective`.
- [x] (2026-08-05) Milestone 4a — browser check of the seeded state: README renders as the front page, both files list, no empty-state misfire, suite green, and the 17 HTTP-smoke failures confirmed pre-existing on `main`.

## Surprises & Discoveries

- Observation: The CLI's sync ignore list excludes only `.treehouse/`, editor swap files, and `.DS_Store` — ordinary dotfiles and dot-directories sync normally.
  Evidence: `packages/cli/src/sync-core.ts:27` — `const IGNORE = [/(^|\/)\.treehouse(\/|$)/, /\.swp$/, /~$/, /(^|\/)\.#/, /\.tmp$/, /(^|\/)\.DS_Store$/, /(^|\/)4913$/]`.
  Consequence: a `.claude/skills/…` directory _would_ sync to the local folder and auto-discover in Claude Code. This plan does not use that route (see `Decision Log`), but the option remains open and costs nothing structurally.

- Observation: There are four separate places that call `workspace.create`, not one. A seed hooked into only the web route would miss the sign-up path, which is the most common one.
  Evidence: `packages/api/server/utils/auth.ts:22`, `packages/api/server/routes/api/workspaces/index.post.ts:19`, `packages/api/server/utils/workspace.ts:299`, `packages/api/server/utils/mcp.ts:648`.

- Observation: The `packages/api` HTTP smoke suites (`invite-flow`, `device-flow`, `cli-sync`, `files-routes`, `mcp`, `read-state-routes`) fail 17 tests against a live dev server — and they fail identically on clean `main`. This is NOT caused by the seed, though it looked like it might be: the seed adds two synchronous file writes inside better-auth's user-create hook, and the failures cluster on sign-up steps timing out at 5s.
  Evidence: `git stash push -u` then re-running `SMOKE_BASE=http://localhost:4413 vp test` produced the same "Test Files 4 failed … Tests 17 failed" in the same files. Running with `TREEHOUSE_SEED=0` made it _worse_ (29 failures), not better, which rules the seed out from the other direction.
  Consequence: these suites are skipped by default (`describe.skipIf(!serverUp)`) and appear to have rotted unnoticed. Worth a separate fix; out of scope here.

- Observation: The app renders literal backtick characters around inline code, so the inline-code spans in the seeded README display with visible backticks either side.
  Evidence: reading textContent off the rendered element returns "treehouse" with no backticks — they are added by @tailwindcss/typography's default code::before / code::after rules, enabled at `packages/app/app/assets/css/tailwind.css:11`.
  Consequence: pre-existing and app-wide (it affects every markdown file in every workspace, not just the seed), so it is left alone here. If it is not wanted, it is a one-line typography override, not a content change.

- Observation: The `claude.ai/new?q=` and `chatgpt.com/?q=` prefill parameters are conventional, not formally documented, and claude.ai's has reportedly been removed and restored at least once. Claude Code's `claude-cli://open?q=` by contrast IS documented, caps `q` at 5,000 characters, warns the user for prompts over 1,000, and never sends the prompt — it only fills the box.
  Consequence: the two web-chat buttons can silently degrade to "opens an empty chat", which is why Copy prompt is a permanent sibling rather than a nicety, and why `buildSetupPrompt` throws rather than emitting an over-length prompt that the handler would truncate into a convincing half-instruction.

- Observation: Adding the CTA card made the seeded README contradict itself on screen — the card offers one click while the README directly beneath it walked through the same thing as three manual steps.
  Evidence: visible in the first post-implementation screenshot; the README's "Set it up" list sat immediately under four buttons that did the whole list.
  Consequence: the README now opens that section by pointing at the buttons and framing the steps as the by-hand alternative. It still has to stand alone in the local synced folder, where no card exists, so the steps stay.

- Observation: `treehouse sync` silently does nothing and reports "up to date" when the folder has no `.treehouse/config.json`, even though config was supplied entirely through the `TREEHOUSE_*` environment variables, which `packages/cli/src/config.ts:28` explicitly supports.
  Evidence: an empty folder plus a workspace holding two files produced `up to date` and pulled nothing. The cause is the root-liveness gate at the top of `runSync` (`packages/cli/src/sync.ts`): `checkRootLiveness` uses `.treehouse/config.json` as its liveness marker, so a folder without one returns early with an empty summary — which the CLI prints as success. Writing the config file by hand made the same command pull both files.
  Consequence: env-var-only configuration is a documented path that cannot actually sync, and it fails silently rather than saying "this folder isn't linked". Not caused by this work and out of scope here, but worth its own fix — the guard is right, the reporting is not.

- Observation: Verifying in a real browser cost far more effort than the feature did, for two avoidable reasons — Nuxt DevTools' floating frame covers the sign-up submit button (`agent-browser` refuses the click), and navigating to the API origin to accept its certificate drops the app-origin session.
  Evidence: `✗ Element '@e9' is covered by <nuxt-devtools-frame …>`; and a later `/w/<id>` load rendered the sign-in page.
  Consequence: use `find label … fill` plus `press Enter` to submit, and do not cross origins mid-session. Worth adding to `docs/desktop/testing-onboarding-locally.md` if anyone else drives the app this way.

## Decision Log

- Decision: The person's own agent runs the interview and the research. Treehouse seeds files and runs no inference.
  Rationale: It matches the product's stated design test ("could Claude Code run it perfectly?"), costs nothing per signup, works identically for a self-hoster with no API keys, and is agent-agnostic. The known weakness — a person who signs up on the web and never connects an agent sees instructions addressed to nobody — is handled by writing `README.md` for the human, with connecting an agent as its single call to action.
  Date/Author: 2026-08-05, agreed with the user.

- Decision: The kit is a root `README.md` plus a root `AGENTS.md`. Not a hidden dot-folder, and not `.claude/skills/`.
  Rationale: `AGENTS.md` is the cross-agent convention read by Claude Code, Codex, Cursor and others, so one file serves every agent rather than one vendor. Keeping both at the root means the human can see exactly what their agent was told, which matters for trust in a product whose pitch is data ownership. A hidden folder would be tidier but agents find it less reliably and humans cannot audit it. The cost — two files sitting at the root — is paid off by the self-retirement step at the end of the bootstrap.
  Date/Author: 2026-08-05, agreed with the user.

- Decision: The folder structures ship as four named templates the agent picks from, embedded inline in `AGENTS.md` rather than as separate template files.
  Rationale: Named templates are predictable, reviewable, and demoable; a pure prompt would produce output that varies per agent with nothing concrete to test. Inline keeps the root footprint at two files and keeps `AGENTS.md` self-contained, which matters because an agent reading it over MCP pays a round trip per extra file.
  Date/Author: 2026-08-05, agreed with the user.

- Decision: Seeded writes are attributed to `principal: "agent"` with the label `Treehouse`.
  Rationale: `Actor.principal` in `packages/api/server/utils/files.ts:21` is exactly `"agent" | "human"`. There is no system principal, and adding one is a schema change to `ChangeEvent` that this feature does not justify. `"agent"` is the closer of the two — a seed is not a person typing. The label disambiguates it in the change feed.
  Date/Author: 2026-08-05.

- Decision: Add one-click hand-off CTAs (Open in Claude Code / Claude / ChatGPT / Copy prompt) on an un-set-up workspace, carrying a single prompt that names both routes to the files — local synced folder preferred, MCP as the fallback.
  Rationale: The seeded README asks the user to connect a folder, open an agent, and type a sentence. That is three manual steps at the exact moment they are least invested. One prompt serves all three targets because the targets differ in what they can reach (Claude Code has a filesystem; the two web chats do not) and the agent is better placed than we are to work out which route applies to it. Copy prompt always sits alongside the deep links because it is the one route that cannot break if a `?q=` parameter stops being honoured.
  Date/Author: 2026-08-05, requested and scoped with the user.

- Decision: The Claude Code link passes no `cwd`, so the session opens in the user's home directory.
  Rationale: `claude-cli://open` accepts `cwd`, which would be far better — but the web app deliberately never learns the synced folder's absolute path (`packages/app/app/utils/desktopApp.ts`: "the full path never leaves the shell"), so only the Electron shell could build such a link. The user chose the browser-wide version over a desktop-only one. The prompt compensates by telling the agent to find the folder or ask where it is. Revisit by adding a shell IPC that constructs the link locally if the home-directory landing proves annoying in practice.
  Date/Author: 2026-08-05, agreed with the user.

- Decision: The card's visibility keys off "no folders and at most two files", not "does AGENTS.md exist".
  Rationale: The bootstrap's last step REWRITES `AGENTS.md` into workspace-specific conventions rather than deleting it, so its presence says nothing about whether setup happened — keying off it would pin the card to the workspace forever. The arrival of folders is the real signal. The rule also covers a genuinely empty workspace (`TREEHOUSE_SEED=0`), which still deserves the offer.
  Date/Author: 2026-08-05.

- Decision: A seed failure must never fail workspace creation.
  Rationale: The seed writes through the file service, which can fail for reasons entirely unrelated to creating a workspace — the blob store being unreachable, or a workspace quota already at its limit. Signing up must not 500 because a README could not be written. The seed is wrapped in a try/catch that logs and continues.
  Date/Author: 2026-08-05.

## Outcomes & Retrospective

Milestones 1–3 are complete and the web-side outcome is verified by eye. A fresh sign-up now lands on a workspace whose front page is the seeded README rather than an empty file list: `packages/api/server/utils/seed.ts` writes the kit at all four creation sites, the app's existing folder-default-page convention renders `README.md` with no front-end change at all, and the sidebar shows both files with no empty-state misfire. Total server-side cost is two small modules and five one-line call-site edits; no schema change, no front-end change, and no inference.

The suite has grown as work landed, so any single number here dates quickly. For the record, `vp test` from the repository root reported 759 passed at the end of Milestone 3 (2026-08-05, server-side seed only), 770 after the hand-off card and its tests (2026-08-05), and **773 after the PR-review fixes (2026-08-06)** — the current figure. Re-run the command rather than trusting the number.

**The central claim is now verified.** On 2026-08-06 the guide was run cold: a fresh subagent, with no knowledge of how `AGENTS.md` was written, was dropped into a real CLI-synced folder and given only "Set up this workspace." A human played the owner of a real small business (ryeandbeyondcottages.co.uk — holiday-cottage lettings in Camber, East Sussex) and answered in character. 46 tool calls, ~7.5 minutes, 19 files.

What the guide actually produced, against the five things listed as untested before the run:

The **interview** happened and nothing was created before it. The agent read `AGENTS.md`, recognised it as a setup guide, and stopped to ask the four questions rather than guessing.

The **templates were adapted, not copied.** From an interview about holiday lettings it proposed `Properties/` and `Owners/` — neither of which is in the company template — and dropped `Meetings/` and `People/` as not applicable. It correctly identified that a letting agency has two distinct relationships (owners and guests) and kept them apart, because the owner had said so.

**Step 3's conventions were applied and then improved on.** Told "the changeover notes should be the first thing you see when you open a property", the agent worked out on its own that a folder's `README.md` IS its front page and put the changeover notes there — using the Treehouse convention the guide documents, to solve a request the guide never anticipated.

**The anti-fabrication rules held under real pressure.** Every researched file carried `status: draft` and a real `sources:` list, with claims quoted verbatim from the site. More tellingly, the agent found two genuine contradictions and reported them instead of smoothing them over: the owner said Tollgates sleeps 14 and is dog-friendly while the live site says 9 and no dogs, and the site advertises ten properties when the owner manages four. It also SKIPPED the Visual identity file entirely — "nothing concrete on colours/fonts/logo on the site worth stating as fact, and a vague guess wasn't worth writing" — which is exactly the "a missing file is better than a confident empty one" instruction being honoured when it would have been easier to waffle. And it left the changeover fields (bin day, stopcock, key safe) blank rather than inventing them.

**Self-retirement was offered and completed.** It asked before doing it, then rewrote `README.md` into a real front page for the business and replaced the 10,361-byte generic guide with 4,994 bytes of workspace-specific conventions.

The separation rule was also verified mechanically: grepping all four guest-facing `Welcome Guide.md` files for "key safe", "stopcock" and "alarm code" returns nothing. No operational detail leaked into guest-facing content.

Two process notes for whoever reads this next. First, the E2E was run against the CURRENT content including the Inbox section, so the Inbox instructions are covered by this result too. Second, during verification I twice read a file mid-write and briefly concluded a write had failed; both had landed. When checking an agent's output, compare after it reports completion, not while it is still running.

Two things surfaced that are worth someone's attention but were deliberately left alone: the pre-existing 17-test failure in the HTTP smoke suites (they only run against a live server, so the rot was invisible), and the app-wide literal backticks around inline code. Both are recorded above with evidence.

## Context and Orientation

This section assumes no prior knowledge of this repository. Read it before touching code.

Treehouse is a shared file workspace used by both people and their AI coding agents. Its server is `packages/api`, a Nitro application (Nitro is a server framework; its route files live under `packages/api/server/routes` and its shared helpers under `packages/api/server/utils`). Its web front end is `packages/app`, a Nuxt single-page application. `packages/db` holds the Prisma database client. `packages/cli` is a command-line tool that two-way-syncs a local folder against a workspace. `packages/desktop` is an Electron application that wraps the same sync for people who do not use a terminal.

A **workspace** is the unit of storage: a namespace of files belonging to one organisation. Its files are plain bytes with a path, stored with their metadata in Postgres and their contents in a blob store (Cloudflare R2 in production, a local directory in development).

The **file service** is `packages/api/server/utils/files.ts`. It is the single write path for every way a file can be written — the REST API, the MCP server, and the CLI all go through it. You obtain it by calling `useFileService()`, which returns an object satisfying the `FileService` interface declared at `packages/api/server/utils/files.ts:81`. The two methods this plan uses are:

    stat(workspaceId, path, actorId?) => Promise<{ version: number } | null>

    write({ workspaceId, path, body, contentType, baseVersion, actor, nowIso }) => Promise<WriteResult>

`write` takes a `body` of bytes, a `contentType` string such as `text/markdown`, and an `actor`. It implements _optimistic concurrency_: `baseVersion` is the version number the caller believes the file is currently at, and if the file has moved on since, the write does not overwrite — it lands the new content in a differently-named "conflicted copy" and reports that in its result. `WriteResult` is declared at `packages/api/server/utils/files.ts:63` and carries `ok`, an optional `version`, an optional `conflict`, and the flags `quotaExceeded` and `forbidden`. The seed in this plan avoids the conflict machinery entirely by checking `stat` first and skipping any path that already exists.

**MCP** stands for Model Context Protocol; it is the standard by which an AI agent connects to an external tool server. Treehouse's MCP server is built in `packages/api/server/utils/mcp.ts` and exposed at the HTTP route `/api/mcp`. When an agent connects, the server hands it a block of prose called _server instructions_ — free text telling the agent how this particular server expects to be used. Treehouse's is the constant `SERVER_INSTRUCTIONS` at `packages/api/server/utils/mcp.ts:163`. It currently documents the front-matter conventions the web UI understands. Milestone 3 adds one paragraph to it.

**Front matter** is a block of YAML at the very top of a markdown file, fenced by a line of three hyphens before and after. The Treehouse web app reads specific keys from it. Two matter here. A `date: YYYY-MM-DD` key on a markdown file places that file on its folder's calendar view for that day. A `view: calendar` key in a _folder's default page_ makes that folder open as a calendar, and a `title:` key there gives the folder a human-readable heading in place of its raw folder name.

A **folder default page** is the file a folder presents as its front page in the web app instead of a bare file listing. The candidates, in precedence order and matched case-insensitively, are `README.md`, then `index.md`, then `index.html`. This is implemented in `packages/app/app/utils/treehouse.ts:99` as `DEFAULT_PAGE_NAMES`. This is why the seeded `README.md` becomes the visible front page of a new workspace with no extra work: the convention already exists and already works.

Workspaces are created in exactly four places, and every one of them must seed:

The first is sign-up. `provisionForNewUser` in `packages/api/server/utils/auth.ts:14` runs inside better-auth's user-creation hook and gives every new user an organisation, a membership, and a workspace named "Default" at `packages/api/server/utils/auth.ts:22`. This is the highest-traffic path and the one the desktop onboarding lands on.

The second is the web app's create-workspace button, which posts to the route handler at `packages/api/server/routes/api/workspaces/index.post.ts`, creating the workspace at line 19.

The third is a lazy fallback: `resolveWorkspace` in `packages/api/server/utils/workspace.ts:292` returns an organisation's oldest workspace and creates a "Default" one at line 299 if the organisation somehow has none.

The fourth is the MCP tool `create_workspace`, registered at `packages/api/server/utils/mcp.ts:628`, which lets an agent create a workspace directly; the create call is at line 648.

Finally, the **local folder path**. The CLI and the desktop app sync a workspace to a directory on the person's machine. `packages/cli/src/sync-core.ts:27` defines what sync skips: only `.treehouse/` (the sync tool's own state), editor swap and temporary files, and `.DS_Store`. Everything else, including ordinary dotfiles, syncs both ways. So a `README.md` and an `AGENTS.md` seeded server-side arrive in the person's local folder on first sync, and Claude Code opened in that folder reads `AGENTS.md` automatically because that is the file it looks for. That is the whole delivery mechanism: no plugin, no integration, no installation step.

## Plan of Work

### Milestone 1 — Seed on creation

Scope: a new server module that writes the two kit files into a workspace, wired into all four creation sites, safe to call twice, and unable to break workspace creation when it fails. At the end of this milestone a newly created workspace contains two files. Their content is a placeholder at this stage; Milestone 2 writes the real text. Splitting it this way keeps the wiring testable without waiting on prose.

Create `packages/api/server/utils/seed.ts`. It exports one function:

    export async function seedWorkspace(workspaceId: string): Promise<void>

The module holds the kit as a constant array of `{ path, body }` entries. For each entry it calls `stat(workspaceId, path)` on the file service and skips the entry when `stat` returns anything other than `null`. Only when the path is absent does it call `write` with `baseVersion: undefined`, `contentType: "text/markdown"`, and

    actor: { principal: "agent", actorLabel: "Treehouse" }

Skipping on an existing path is what makes the function idempotent. It matters: without it, calling `seedWorkspace` twice would hit the file service's optimistic-concurrency path and produce a conflicted copy of the README, which is exactly the sort of confusing artefact that erodes trust in a sync product.

Wrap the whole body in a `try`/`catch` that logs the error with the workspace id and returns normally. State this intent in a comment at the function so a later contributor does not "fix" it into a throw: creating a workspace must succeed even when its seed cannot be written, because the seed is a convenience and the workspace is the product.

Add an environment escape hatch. Read `process.env.TREEHOUSE_SEED` and return immediately when it is exactly the string `"0"`. This gives self-hosters a way to opt out of opinionated content in their instance, and gives tests a way to assert on a genuinely empty workspace. Document it in `packages/api/.env.example` with a one-line comment.

Now wire the four call sites. In each one, call `await seedWorkspace(created.id)` immediately after the `workspace.create` that produces it.

In `packages/api/server/utils/auth.ts`, `provisionForNewUser` currently discards the created workspace. Capture it into a variable and seed it.

In `packages/api/server/routes/api/workspaces/index.post.ts`, the handler currently returns the `create` call directly. Capture the result into a variable, seed it, then return the variable.

In `packages/api/server/utils/workspace.ts`, `resolveWorkspace` returns its `create` call directly on the fallback branch. Capture, seed, return.

In `packages/api/server/utils/mcp.ts`, the `create_workspace` tool at line 628 already captures the result as `created`. Seed it before the `okData` return. Note that `created` is built with a `select` that returns only `id` and `name`; `id` is all the seed needs.

Write `packages/api/test/seed.test.ts`. Look at `packages/api/test/files-service.test.ts` for the established setup shape — it creates an organisation and a workspace directly through the Prisma client at `packages/api/test/files-service.test.ts:25`. The tests to write, in prose:

A workspace that has been seeded lists exactly `README.md` and `AGENTS.md` through `useFileService().list()`, and reading each returns a non-empty body whose content type is `text/markdown`.

Calling `seedWorkspace` a second time on the same workspace leaves the file list unchanged at two entries, and the version of `README.md` is still 1 — proving the skip fired rather than a second write landing.

When a `README.md` already exists at version 1 with different content, seeding does not modify it and does not create a conflicted copy. Assert the body is still the pre-existing one and the list still has no path containing the word `conflict`.

With `TREEHOUSE_SEED` set to `"0"`, seeding produces an empty workspace. Restore the variable afterwards so test order does not matter.

Also add a test that the sign-up path seeds, since that is the path that actually matters to a new user and the one most likely to be missed in a refactor. `packages/api/test/auth-api-key.test.ts` and `packages/api/test/device-flow.test.ts` already exercise account creation; follow whichever of them sets up a real user through better-auth, then assert the resulting workspace lists the two files.

Before finishing this milestone, check whether any existing test asserts that a freshly created workspace is empty. Run the API suite and read the failures rather than guessing. Existing tests mostly create workspaces directly through `db.workspace.create`, which bypasses the seed entirely, so most should be unaffected — but `packages/api/test/files-routes.test.ts` and `packages/api/test/mcp.test.ts` both make assertions about listings and are the likely places for a surprise. Where a test breaks because of the seed, prefer setting `TREEHOUSE_SEED=0` for that test over loosening its assertion, so the test keeps testing what it was written to test.

Commands, run from the repository root:

    pnpm --filter api run test
    vp check

Acceptance for this milestone: `pnpm --filter api run test` passes with the new `seed.test.ts` included, and `vp check` is clean. To see it by hand rather than by test, start the API with `pnpm dev:api`, create a workspace through the web app, and request its listing:

    curl -s "$API/api/workspaces/$WORKSPACE_ID/list" -H "Cookie: $SESSION"

and observe `README.md` and `AGENTS.md` in the response.

### Milestone 2 — Author the kit content

Scope: replace the placeholder bodies with the real text. Nothing structural changes; this milestone is entirely about the words, and the words are the feature. At the end of it, a person reading the seeded `README.md` knows what to do next, and an agent reading the seeded `AGENTS.md` can run a full bootstrap without further instruction.

Keep both bodies in `packages/api/server/utils/seed.ts` as template literals, or in a sibling `packages/api/server/utils/seed-content.ts` if the module grows past comfortable reading. Do not fetch them from disk at runtime: the API is deployed as a bundle and reading files from the filesystem at runtime is a portability trap.

**`README.md`** is addressed to a human who has just arrived at an empty workspace. It should be short — under a screen. It opens with front matter carrying a `title:` key so the web app shows a proper heading rather than the raw workspace name. It then explains in two or three sentences what a Treehouse workspace is: a folder of ordinary files that the person's team and their agents share, which syncs to their computer and renders on the web. Its single call to action is to connect an agent — through the desktop app, the CLI, or MCP — and then tell that agent to set up the workspace, with the literal sentence to type given in the file so there is no guessing. It closes by saying that the agent will replace this file once setup is done, so the person is not surprised when it changes underneath them.

Write it for someone who has never used the product. Resist listing features.

**`AGENTS.md`** is addressed to an agent. Its structure, in order:

It opens by stating what Treehouse is in two sentences and what this specific file is: a one-time setup guide for a workspace that has not been set up yet, which the agent should follow when the person asks it to set up or bootstrap this workspace. It states plainly that if the workspace already has a real folder structure, this file is stale and the agent should say so rather than start over.

Then the **interview**. Instruct the agent to ask, conversationally and a few at a time rather than as a form, what this workspace is for. The things it needs to establish: whether this is for a company, a personal knowledge base, client work, or a single project; who will read it (just them, a team, clients); what they expect to put in it first; and whether there is an existing website, brand, or public presence behind it. Tell the agent to stop and confirm its understanding before creating anything. Creating twenty folders someone did not ask for is worse than creating none.

Then the four **templates**. Each is presented with a name, a sentence on who it suits, and its folder tree written as an indented block. Adapt names to the person's own vocabulary during the interview — if they call their customers "members", the folder is `Members`.

The _Company knowledge base_ template suits a business capturing what it knows in one place. Its tree: `Brand/` for identity, voice, and visual rules; `Product/` for what the company sells and how it works; `People/` for roles, onboarding, and ways of working; `Customers/` for accounts, feedback, and research; `Operations/` for process and policy; and `Meetings/` for dated notes.

The _Personal knowledge base_ template suits one person's second brain. Its tree: `Notes/` for durable notes; `Projects/` for things with an end date; `Areas/` for ongoing responsibilities; `Resources/` for reference material; and `Journal/` for dated entries.

The _Client work_ template suits an agency or freelancer. Its tree: `Clients/` with a subfolder per client, each containing `Brief/`, `Deliverables/`, and `Notes/`; `Brand/` for the practitioner's own identity; `Proposals/`; and `Templates/` for reusable documents.

The _Project_ template suits a single initiative. Its tree: `Docs/`; `Decisions/` for dated decision records; `Research/`; and `Meetings/` for dated notes.

For each template, instruct the agent to give every folder a `README.md` explaining what belongs in it — a one-paragraph description, not a placeholder. An empty folder tree teaches nobody anything; the descriptions are what make the structure usable by the next person and by the next agent.

Instruct the agent that for the dated folders — `Meetings/`, `Journal/`, and `Decisions/` — the folder's `README.md` front matter should carry `view: calendar` and a `title:`, and that files placed in them should carry a `date: YYYY-MM-DD` key in their own front matter. Explain in the file what this does: the web app lays those folders out as a month calendar. This is worth doing carefully, because it means the bootstrap demonstrates a real Treehouse capability on day one rather than producing a structure indistinguishable from a plain folder.

Then the **research** phase, which applies to the company and client templates and is offered, not assumed. Instruct the agent to ask whether the person wants it to research their public presence, and if so to ask for the website address and any public profiles. If the agent has web access it fetches those; if it does not, it must say so plainly and ask the person to paste what it needs, rather than filling the gap from memory.

What it drafts, into `Brand/`: a positioning note covering what the organisation does and who for; a tone-of-voice note derived from how they actually write on their own site, with quoted examples; a visual identity note covering colours, typefaces and logo usage where these are discoverable; a products or services note; and an audience note. The specific files depend on what the research actually turned up — instruct the agent not to create a file it has nothing real to put in.

Three rules govern this phase, and they are the most important paragraphs in the file. First, every researched file carries front matter with `status: draft` and a `sources:` list of the URLs the content came from. Second, the agent never states a fact it did not find in a source; where it is inferring, it says so in the text. Third, the agent tells the person, at the end, exactly which files are drafts and asks them to review. Fabricated brand facts presented as verified would be worse than an empty workspace, because the person would build on them.

Finally, **self-retirement**. Once the structure exists and the person is happy, the agent rewrites `README.md` as a genuine front page for the workspace that now exists — what it is, what is in it, where to put things — and replaces `AGENTS.md` with conventions specific to this workspace: its structure, its naming conventions, its front-matter conventions, and anything the person said during the interview that a future agent would need to know. Instruct the agent to confirm with the person before doing this. This is what stops setup instructions from living at the root of every workspace forever, and it converts a generic guide into a workspace-specific one, which is more valuable than either.

There is no automated test for prose quality. The acceptance for this milestone is Milestone 4: a real agent following the file end to end and producing something a human judges good.

One check worth running mechanically, though, is that both files parse: their front matter is valid YAML and the markdown renders. After seeding a workspace, open both files in the web app and confirm the front-matter block is picked up as metadata rather than rendered as literal hyphens and text.

### Milestone 3 — Make agents find it

Scope: an agent connecting over MCP has no reason to read `AGENTS.md` unless something tells it to. One paragraph in the server instructions fixes that. At the end of this milestone, an agent that connects to a fresh workspace over MCP and is asked to help will find the setup guide without being told the filename.

Edit `SERVER_INSTRUCTIONS` in `packages/api/server/utils/mcp.ts:163`. Add a paragraph stating that if `AGENTS.md` exists at the workspace root the agent should read it before doing anything else, because it carries that workspace's conventions — and that in a workspace that has not been set up yet it carries a setup guide the agent should follow when asked to set the workspace up.

Keep it to a few sentences. The instructions are sent to every client on every connection and are already carrying the front-matter documentation; bloating them costs every agent context on every session.

Note the comment already sitting above that constant: "Keep this in sync with the front-matter features the app reads." Extend that comment to mention the `AGENTS.md` convention too, so the next person editing either side knows they are coupled.

Check whether `packages/api/test/mcp.test.ts` asserts anything about the instructions string; if it does, update it. If it does not, add a small test that the instructions mention `AGENTS.md`, so a future edit that drops the paragraph fails loudly rather than silently regressing agent discovery.

Acceptance: `pnpm --filter api run test` passes, and the paragraph is visible in the instructions returned by an MCP initialize handshake against a local server.

### Milestone 4 — Verify by using it

Scope: actually run a bootstrap. This repository's standing instruction, in `CLAUDE.md`, is that green tests say the code runs, not that it works — and that nearly every user-experience defect in this project's history was found by using the app rather than by a test. A feature whose entire substance is whether an agent behaves well when reading a document cannot be signed off on a passing test suite. Do not skip this milestone, and do not report the feature done without it.

Start the stack from the repository root:

    pnpm dev

This starts the API and the web app on this worktree's own hostnames against its own database; `pnpm env:status` prints the URLs if you need them. Sign up a brand-new account through the web app — a new account, not an existing one, because the sign-up path is the one being verified.

First, look at the workspace in the browser before doing anything else. Use the `agent-browser` skill to drive a real browser and take a screenshot. What you are checking: the seeded `README.md` renders as the workspace front page rather than appearing as a file in a list that the person has to find and click; its heading comes from the front-matter `title:`; and the page reads as a welcome rather than as a document someone left behind. If the sidebar still shows the "No files yet" empty state alongside two files, that is a defect — find it in `packages/app/app/components/AppSidebar.vue:194` and fix it. Note the `agent-browser` caveat from `CLAUDE.md`: close its daemon before attaching to a different target, because `--cdp <port>` is silently ignored when one is already running and you will screenshot the wrong browser without noticing.

Second, run a real bootstrap. Connect the workspace to a local folder — either through the desktop app, for which `docs/desktop/testing-onboarding-locally.md` has a tested recipe, or through the CLI, which is the faster route for this purpose. Confirm both seeded files arrive in the local folder. Then open that folder in Claude Code and type the sentence the README tells the person to type. Let it run. Do not coach it, and do not correct it mid-flight — the point is to find out what the document actually produces in the hands of an agent that has only the document.

Answer the interview as a plausible small company with a real public website, so the research phase has something genuine to work with. Let it create the structure. Let it do the research. Then read what it wrote, with a sceptical eye: are the brand notes accurate against the actual site, or does the agent state things it could not have known? Are the draft markers present on every researched file? Did it offer the retirement step, and did the rewritten `README.md` describe the workspace that now exists?

Third, look at the result in the web app. Screenshot the workspace with its new structure. Open a dated folder and confirm it opens as a calendar rather than a listing — that is the front-matter convention working end to end, and if it does not fire, the instruction in `AGENTS.md` is wrong and needs correcting.

Record what you find in `Surprises & Discoveries`, including the things the agent got wrong. Then fix the document and run it again. The second run is where the value is: the first run tells you what the prose actually says, as distinct from what you meant it to say.

Anything genuinely unreachable this way — native dialogs, tray behaviour, packaged-app specifics — belongs in `docs/desktop/qa-checklist.md` rather than being quietly skipped. Where you could not look, say so plainly in the final report rather than implying it was checked.

Acceptance: a screenshot of a freshly seeded workspace's front page, a screenshot of the same workspace after a bootstrap run, and a written account in `Outcomes & Retrospective` of what the agent produced and what had to change in the kit as a result.

## Out of Scope

A Treehouse-hosted agent that runs the interview server-side in a web chat panel. This was considered and rejected for now; the seam is left open in that `AGENTS.md` is a plain document any runner could consume, but no hosted runner is built. A person who signs up on the web and never connects an agent gets a README that tells them to connect one, and nothing more.

Seeding existing workspaces. This plan seeds at creation only. Back-filling every workspace that already exists would write files into live workspaces people are already using, which is a change they did not ask for. If it is wanted later it should be an explicit action a person takes, not a migration.

Any change to the desktop or CLI onboarding flows. They already deliver the workspace to a local folder; the seeded files ride along on the existing sync with no code change on either side.