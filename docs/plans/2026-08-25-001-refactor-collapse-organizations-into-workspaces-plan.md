# Collapse organizations into workspaces (workspace becomes the only user-facing container)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds. It must be maintained in accordance with `.agent/PLANS.md` (at the repository root).

## Purpose / Big Picture

Treehouse today exposes two nested containers to users: an **organization** (a team of people, provided by the better-auth "organization" plugin) and **workspaces** (file spaces that belong to an organization). Users find this confusing: the product's real unit of collaboration is the workspace, yet membership, invites, and switching all happen at the organization level. Worse, because access is organization membership, inviting someone to share _one_ workspace silently grants them _every_ workspace in the organization.

After this change, the **workspace is the only container a user ever sees**. Every workspace has its own members, roles, and invites. Inviting someone to a workspace grants exactly that workspace. The workspace switcher shows every workspace the user is a member of, regardless of who created it. There is no "active organization", no organizations page, no organization switching.

Crucially, we do **not** remove the better-auth organization plugin. Organizations remain in the database as an invisible 1:1 implementation detail: every workspace owns exactly one hidden organization (a "shadow org"), and "membership of a workspace" is implemented as "membership of its shadow org". This keeps the plugin's membership rows, roles (owner/admin/member), and removal hooks (which revoke an ex-member's sync keys) driving everything, with no schema changes and no custom membership machinery.

How to see it working when done: sign up (you get "Your Workspace"), create a second workspace, create an invite link from workspace A, accept it in a second browser as another user — the second user sees workspace A in their switcher and _not_ workspace B. The organizations page no longer exists.

## Progress

- [x] (2026-08-25 18:05Z) Milestone 1: membership-based reads + workspace-resolved invite accept (API). Added `workspacesForUser` and (early, see Decision Log) `createWorkspaceWithOrg` to `packages/api/server/utils/workspace.ts`; rewrote `currentWorkspaceForUser`; `GET /api/workspaces` now unions memberships; invite accept + preview resolve the org through the workspace. New in-process suite `packages/api/test/workspace-membership.test.ts` (9 tests) plus 2 new HTTP tests in `packages/api/test/invite-flow.test.ts`.
- [x] (2026-08-25 18:09Z) Milestone 2: workspace creation mints a shadow org. All three sites now call `createWorkspaceWithOrg`: `POST /api/workspaces`, the MCP `create_workspace` tool (`buildUserMcpServer`), and `provisionForNewUser` in `packages/api/server/utils/auth.ts` (which now names the personal workspace "<Name>'s Workspace"). Tests: signup naming + 1:1 assertion in `workspace-membership.test.ts`, an end-to-end isolation test in `invite-flow.test.ts` (create two workspaces over HTTP, invite a guest to one, guest's list omits the other and `GET /api/workspaces/<other>/list` 403s), a 1:1 assertion on the MCP-created workspace in `mcp.test.ts`, and `auth-api-key.test.ts`'s signup expectation updated from "Default".
- [x] (2026-08-25 18:14Z) Milestone 3: data migration splitting multi-workspace orgs. `packages/db/prisma/migrations/20260825170951_split_orgs_one_per_workspace/migration.sql`, validated against the worktree database seeded with a three-workspace organization, an already-1:1 organization, and two invite links — see Artifacts. Remaining for a later deploy (explicitly NOT done here): the production `pg_dump` snapshot and `prisma migrate deploy` against Railway.
- [x] (2026-08-25 18:22Z) Milestone 4: UI contraction (completed: all code and API tests; remaining: visual verification (deferred to parent session)). Deleted `packages/app/app/pages/organizations.vue` and every `/organizations` link; dashboard lost its "Active organization" row and now names the current workspace in its invite card; `useWorkspaceData` keys the list by user id; the invite page drops `organization.setActive` and shows the workspace name; new `packages/app/app/components/WorkspaceMembers.vue` opens from a "Members" item in the sidebar menu. API: `GET /api/workspaces/:id/members` adds `role`, new `DELETE /api/workspaces/:id/members/:userId` (cookie-only, owner/admin, last-owner protected, delegates to `auth.api.removeMember` so key revocation fires). Tests: new `packages/api/test/members-routes.test.ts`, 8 route tests, all passing. `npx nuxt build` in `packages/app` succeeds. NOT DONE HERE: the browser walkthrough and screenshots — this implementation session was explicitly instructed not to start dev servers for visual verification, so the Milestone 4 acceptance walkthrough (sign up → create second workspace → invite → accept as B → B sees one workspace → remove B) has NOT been performed or screenshotted.
- [x] (2026-08-25 18:26Z) Milestone 5: cleanup, docs, copy changes (completed: all code, docs and copy; remaining: the full visual verification, deferred to the parent session with Milestone 4's walkthrough). Deleted `activeOrgForUser` and `resolveWorkspace` (both uncalled after Milestones 1–4), removed `activeOrganizationId` from `RequestPrincipal` and from both places that populated it, and dropped the field from `GET /api/me` (nothing consumed it; `me.get.ts` also switched from `toWebRequest` to `webHeaders`). `buildUserMcpServer`'s `list_workspaces` now calls `workspacesForUser` instead of its own two-step query. Docs: `CONCEPTS.md` Workspace + Member-link entries, the `Workspace` and `WorkspaceInvite` comments in `packages/db/prisma/schema.prisma`, `CLAUDE.md` (api/app package descriptions + a new "organizations are invisible" rule), `README.md` (intro, package table, quick-start, auth section). Copy sweep run; the only surviving "organization" strings are internal comments, Prisma field names, and better-auth plugin names.

## Surprises & Discoveries

- Observation: the MCP user-scoped server's `list_workspaces` tool (in `packages/api/server/utils/mcp.ts`, `buildUserMcpServer`) already lists workspaces by the union of the user's memberships, not by active org — the API was ahead of the web app on the target model.
  Evidence: it queries `member.findMany({ where: { userId } })` then `workspace.findMany({ where: { organizationId: { in: ... } } })`.

- Observation: `Organization` in `packages/db/prisma/schema.prisma` DOES carry both back-relations (`members Member[]` and a hand-maintained `workspaces Workspace[]`), so the one-query relation filter in `workspacesForUser` works — the two-step fallback the plan allowed for was not needed.
  Evidence: `schema.prisma` lines 90–103; `db.workspace.findMany({ where: { organization: { members: { some: { userId } } } } })` typechecks and returns the expected rows in `packages/api/test/workspace-membership.test.ts`.

- Observation: `organization.slug` is `String? @unique`. `provisionForNewUser` never set it (always NULL, and Postgres lets many NULLs coexist under a unique index), but a shadow org named after the workspace would collide the moment two users name a workspace the same thing IF we set a naive slug. `createWorkspaceWithOrg` therefore appends 8 hex chars of a UUID to the slugified name.
  Evidence: test "tolerates two workspaces with the SAME name (org slug is unique)" in `packages/api/test/workspace-membership.test.ts`.

- Observation: the HTTP-gated API tests (`describe.skipIf(!serverUp)`, `SMOKE_BASE ?? http://localhost:3001`) cannot authenticate against a server started via `pnpm dev:api`. That script overrides `BETTER_AUTH_URL` in the child process with the worktree's **https** Portless URL, which flips better-auth into secure-cookie mode (`__Secure-` prefixed cookie names), while the test helpers mint their cookies in-process from `packages/api/.env` (`BETTER_AUTH_URL=http://localhost:3010`). Every request then arrives with a cookie name the server does not look for, and all nine invite-flow tests return 401 — including the six that predate this plan.
  Evidence: `pnpm dev:api` → `SMOKE_BASE=http://127.0.0.1:4014 vp test packages/api/test/invite-flow.test.ts` → "Tests 9 failed (9)", every failure `expected 401 to be 200`. Running the raw server instead (`cd packages/api && node ../../node_modules/.bin/nitro dev --port 3010`, which uses the `.env` baseURL) → "Tests 9 passed (9)".

- Observation: `packages/api/test/device-flow.test.ts` has a pre-existing HTTP-gated failure unrelated to this plan: it polls `/api/device/poll` twice back-to-back, and the route's slow-down guard (`packages/api/server/routes/api/device/poll.get.ts`, `pollIntervalS()` default 5s) answers 429. Nothing in the repo sets `DEVICE_POLL_INTERVAL_S`, so the test can only pass against a server started with `DEVICE_POLL_INTERVAL_S=0`.
  Evidence: `SMOKE_BASE=… vp test packages/api/test/device-flow.test.ts` → `AssertionError: expected 429 to be 200` at line 88; the same run against a server started with `DEVICE_POLL_INTERVAL_S=0` passes.

- Observation: `vp check`'s format stage has four pre-existing failures on files this plan does not touch (`docs/brainstorms/2026-07-30-unified-onboarding-requirements.md`, `docs/desktop/testing-onboarding-locally.md`, `docs/solutions/architecture-patterns/electron-remote-content-shell.md`, `packages/desktop/package.json`), and the typecheck stage reports one error until `nitro prepare` has been run in `packages/workers` (missing `.nitro/types/tsconfig.json`). Neither is caused by this work; the validation loop here is `vp check --no-fmt` plus `vp fmt --check` scoped to touched paths.
  Evidence: `git status --porcelain` shows those four files unmodified while `vp check` lists them; `cd packages/workers && npx nitro prepare` takes `vp check --no-fmt` from "Found 1 error" to "Found 0 errors and 4 warnings in 382 files".

## Decision Log

- Decision: keep the better-auth organization plugin and model every workspace as owning exactly one hidden organization, rather than removing the plugin and hand-rolling a `WorkspaceMember` table.
  Rationale: the plugin supplies member rows, roles, and the `afterRemoveMember` hook (which revokes an ex-member's workspace-scoped API keys — see `packages/api/server/utils/auth.ts`). Replacing it means re-running better-auth schema generation, which regenerates the whole `schema.prisma` and would delete the hand-maintained Treehouse models (a documented hazard in `CLAUDE.md`). The 1:1 shadow-org model gets per-workspace membership with zero schema changes. Explicitly requested by the project owner ("leverage as much of the better-auth org plugin as possible").
  Date/Author: 2026-08-25 / Jozef + Claude.
- Decision: migrate existing data by _splitting_ orgs (one new shadow org per extra workspace, copying member rows), never by merging or deleting workspaces, and never changing any `workspace.id`.
  Rationale: every external credential and link (API keys, sync links, shares, invite URLs) references a `workspaceId` or an opaque token — as long as workspace ids are stable and members are copied, every existing key, share, and session keeps working and every user keeps exactly the access they had. Backwards compatibility falls out of this one invariant.
  Date/Author: 2026-08-25 / Jozef + Claude.
- Decision: at invite-accept time, resolve the organization from the invite's `workspaceId` (via the workspace row) instead of trusting the denormalized `workspaceInvite.organizationId`.
  Rationale: the stored org id goes stale if the migration reparents that workspace onto a new shadow org; an old link would then join the wrong (pre-split) org. Resolving through the workspace makes staleness structurally impossible. The migration also rewrites the stored column, but the code fix is the durable guarantee.
  Date/Author: 2026-08-25 / Jozef + Claude.
- Decision: `/api/workspace` (cookie path) resolves to the user's oldest membership's workspace; the response shape `{ id, name }` is unchanged.
  Rationale: for every migrated user this returns the same workspace as the old "active org's oldest workspace" logic, so no client-visible change; and it removes the last dependency on the session's `activeOrganizationId`.
  Date/Author: 2026-08-25 / Jozef + Claude.
- Decision: the data migration renames workspaces still named "Default" to their organization's name (e.g. "Jozef's Team"), and the signup hook henceforth names the personal workspace `"<name>'s Workspace"` (fallback "My Workspace") with the shadow org named identically.
  Rationale: in a flat, cross-team switcher, several workspaces all named "Default" are indistinguishable. The org name is the only personalised name we have for existing rows.
  Date/Author: 2026-08-25 / Jozef + Claude.
- Decision: delete the organizations page outright rather than rebuilding it as a "team" page; add a minimal per-workspace members panel (list + remove) instead.
  Rationale: the page is unmodified better-auth starter scaffolding ("Powered by the better-auth organization plugin"); its only real capability users need — adding people — already exists as workspace invite links on the dashboard. Removal needs a home because it triggers key revocation; a small members panel on the workspace covers it.
  Date/Author: 2026-08-25 / Jozef + Claude.

- Decision: introduce `createWorkspaceWithOrg` in Milestone 1 rather than Milestone 2, and switch the three creation call sites in Milestone 2 as planned.
  Rationale: Milestone 1's rewritten `currentWorkspaceForUser` must auto-provision a workspace for a user with no memberships, and the plan itself specifies it should do so "as in Milestone 2's `createWorkspaceWithOrg`". Defining the helper twice, or inlining a second copy of the provisioning logic, is exactly the drift the shared helper exists to prevent. Milestone 1 therefore adds the helper; Milestone 2 remains a real, separately verifiable milestone because it is the one that makes REST/MCP/signup use it.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: put the Milestone 1 and 2 behavioural assertions in a NEW in-process suite, `packages/api/test/workspace-membership.test.ts`, rather than only extending the HTTP-gated `packages/api/test/invite-flow.test.ts`.
  Rationale: every HTTP suite in `packages/api/test/` is wrapped in `describe.skipIf(!serverUp)` and is silently skipped by a plain `vp test` (baseline: 81 skipped). The core guarantees of this plan — membership-based listing, one org per workspace, and cross-workspace isolation via `authorizeWorkspace` — would then be unverified in CI. Modelled on `packages/api/test/member-revocation.test.ts`, which already runs in-process against the dev database. The genuinely route-level assertions (invite accept after re-parenting, `GET /api/workspaces` shape) stay in the HTTP suite where they belong.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: `GET /api/invites/:token` keeps returning `organizationName`, but resolves it through `workspace.organization.name` instead of `invite.organizationId`.
  Rationale: the plan offered either resolving through the workspace or returning `null`. Resolving costs nothing (it folds into the existing workspace query as a nested `select`) and keeps a deployed-but-not-yet-updated SPA rendering a correct name rather than "the team". The field stops being displayed in Milestone 4 and can be dropped later.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: update `packages/api/test/auth-api-key.test.ts`'s "provisions a personal org + Default workspace on sign-up" to expect `"Test User's Workspace"` instead of `"Default"`, rather than keeping the old name for that path.
  Rationale: the plan explicitly renames the signup workspace, and this assertion is the guard on that path. It was the only test in the repo that hard-coded "Default" as a signup outcome; the surrounding assertions (owner role, seeded `AGENTS.md`/`README.md`) are unchanged and still prove the hook did its job.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: in the Milestone 3 migration, do the "Default" rename FIRST (plan step 4 becomes SQL step 1) and leave the new organizations' `slug` NULL.
  Rationale (order): the plan named split-off organizations after their workspace, so a workspace still called "Default" would have minted an organization called "Default", and the later rename would then set the workspace's name to… "Default". Renaming first means the split-off workspace carries the personalised organization name ("Acme Team") into the organization created for it, and no workspace is left called "Default". Rationale (slug): `organization.slug` is `String? @unique`, nothing in the product reads it, and every organization created before this migration has a NULL slug (Postgres allows unlimited NULLs under a unique index) — so omitting it removes any chance of a unique-constraint violation aborting a production migration. Note the known cosmetic edge case: an organization that owned two workspaces BOTH named "Default" ends up with two workspaces sharing the organization's name. There is no unique constraint on `workspace.name` and no better personalised name available, so this is accepted.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: validate the migration with `pnpm prisma migrate deploy`, not `pnpm prisma migrate dev`, and keep the verification snapshot tables in a separate `migcheck` Postgres schema.
  Rationale: `migrate dev` performs drift detection and offers to RESET the database; a scratch snapshot table sitting in `public` is exactly the kind of drift that triggers it, and the worktree database holds the state the rest of the test suite runs against. `migrate deploy` only applies pending migrations. The `migcheck` schema was dropped afterwards.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: keep the members GET at `packages/api/server/routes/api/workspaces/[workspaceId]/members.get.ts` and add only the new `members/[userId].delete.ts` directory, instead of moving the GET to `members/index.get.ts` as the plan's letter said.
  Rationale: this is already the repo's own convention for exactly this shape — `shares.get.ts` and `shares.post.ts` sit at the top level while `shares/[shareId].delete.ts` lives in a directory. Nitro routes both spellings to the same URL, so following the neighbouring pattern beats a rename that would show up in the diff as a delete plus an add.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: the DELETE route adds two guards the plan did not name — an admin cannot remove an owner, and the route is cookie-only (an API key gets 403 via `requireCookieUser`).
  Rationale: the plan required "owner or admin caller" and "forbid removing the last owner". Without the first extra guard an admin could evict every owner one at a time until only they remained, which defeats the last-owner rule; without the second, a leaked workspace-scoped agent key could evict the very people able to revoke it. Both mirror the reasoning already written into `requireCookieUser`'s comment about key management.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: the dashboard's invite card creates a link for the workspace the switcher currently has open (`useWorkspaceData().workspaceId`), not for whatever `GET /api/workspace` returns, and clears a stale link when the current workspace changes.
  Rationale: invites are per-workspace now, so a card that says "Invite someone to Marketing" must mint a link for Marketing. `GET /api/workspace` returns the user's OLDEST workspace, which after this refactor is frequently not the one on screen — the card would have silently invited people to the wrong workspace. `GET /api/workspace` remains the fallback for the moment before the list resolves.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: the members panel offers a "Leave" action when the row is you, using the same DELETE route.
  Rationale: removal had to live somewhere because it triggers key revocation, and self-removal is the same operation with the same guards (the last owner still cannot leave, so a workspace can never become unadministrable). Adding it costs one ternary in the button label and gives members an exit that otherwise did not exist anywhere in the product.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: also delete `resolveWorkspace` and switch `GET /api/me` from `toWebRequest(event).headers` to `webHeaders(event)`.
  Rationale: the plan told the implementer to grep for `resolveWorkspace` and delete it if uncalled — it was (its only caller was the old `currentWorkspaceForUser`). It also created workspaces named "Default" with no organization or member row, which is now an invalid shape, so leaving it would be a loaded gun. `/api/me` was the last `toWebRequest` on an auth route; it is a GET so the body-locking hazard never bit, but `CLAUDE.md` states the rule absolutely and the file was already being edited to drop `activeOrganizationId`.
  Date/Author: 2026-08-25 / Claude (implementation).

- Decision: also point `buildUserMcpServer`'s `list_workspaces` at `workspacesForUser`.
  Rationale: it had its own two-step `member.findMany` → `workspace.findMany` implementation of the same rule. Two implementations of "which workspaces can this user see" is exactly the drift the shared helper exists to prevent, and the agent-facing path is the one nobody looks at.
  Date/Author: 2026-08-25 / Claude (implementation).

## Outcomes & Retrospective

### 2026-08-25 — Milestones 1–5 implemented (visual verification outstanding)

What was achieved. The workspace is now the only container the code models as user-facing. Access is membership of the workspace's own hidden organization everywhere: `GET /api/workspaces` unions memberships, `currentWorkspaceForUser` takes the oldest of them, the MCP `list_workspaces` tool shares the same helper, and invite accept resolves the organization through the workspace so a re-parented workspace can never strand an old link. Every creation path — REST, MCP, sign-up — goes through `createWorkspaceWithOrg`, so a new workspace is born with exactly one organization and exactly one member. Existing data was reshaped to match by `20260825170951_split_orgs_one_per_workspace`, which preserved every workspace id and every `(user, workspace)` access pair. The organizations page and every reference to it are gone; member management lives on the workspace, with a panel and a `DELETE /api/workspaces/:id/members/:userId` route that goes through better-auth so an ex-member's sync keys are still revoked.

Numbers. Five commits. `vp check --no-fmt`: 0 errors, 4 pre-existing warnings across 384 files. `vp test` with the API server up: 88 files, 1106 passed, 4 skipped, 0 failed (baseline before this work was 1009 passed / 81 skipped, because 78 HTTP-gated tests were being skipped for want of a server). 25 tests were added across `workspace-membership.test.ts` (9, in-process), `members-routes.test.ts` (8, HTTP), `invite-flow.test.ts` (3, HTTP) and assertions inside existing `mcp.test.ts` / `auth-api-key.test.ts` cases.

What remains.

1. **Visual verification of Milestone 4 has NOT been done.** The implementation session was instructed not to run the browser walkthrough. Everything user-facing in Milestones 4 and 5 — the dashboard without its organization row, the switcher, the invite page's new heading, the members panel and its remove/leave buttons — has been typechecked, built (`nuxt build` succeeds) and exercised at the API level, but nobody has looked at it. Per `CLAUDE.md` that is the check most likely to catch a real defect, and it is still owed.
2. **The production migration has not been deployed.** Before deploying, run `psql "$DATABASE_URL" -c "SELECT organization_id, count(*) FROM workspace GROUP BY 1 HAVING count(*) > 1;"` to see whether prod even has a multi-workspace organization, then `pg_dump "$DATABASE_URL" > treehouse-pre-org-split.sql`, then `prisma migrate deploy`. The migration is a no-op if prod is already 1:1.
3. **Existing production users keep their old workspace names** unless they were literally "Default", in which case they take their organization's name (e.g. "Jozef's Team"). Two workspaces that were both "Default" in one organization will end up sharing a name — cosmetic, and renaming is a one-click fix in the app.

Lessons learned.

- The HTTP-gated API suites are invisible by default. A plain `vp test` skipped 81 tests, and nothing in the output distinguishes "skipped because no server" from "fine". Putting this plan's core guarantees in an in-process suite instead was the single highest-value testing decision here — those assertions run in CI, the HTTP ones do not.
- `pnpm dev:api` and the in-process test helpers disagree about `BETTER_AUTH_URL` (https Portless vs the `.env` http URL), which silently makes every cookie-authenticated HTTP test 401. Anyone trying to run the gated suites needs the raw `nitro dev --port 3010` incantation, and `DEVICE_POLL_INTERVAL_S=0` on top of it for `device-flow.test.ts`. That is worth a line in the README the next time someone touches these tests.
- Ordering the migration's rename step BEFORE the split, rather than after as drafted, was a one-line change that turned "mint an organization literally called Default" into sensible personalised names. Reading the plan's SQL as a sequence rather than a set was what surfaced it.

## Context and Orientation

This is a pnpm/Vite+ monorepo. The relevant packages:

- `packages/api` — a Nitro (H3) API server. Routes live under `packages/api/server/routes/api/…` (file-based routing: `workspaces/index.get.ts` is `GET /api/workspaces`). Shared server logic lives in `packages/api/server/utils/`. Auth is **better-auth**, configured in `packages/api/server/utils/auth.ts`, with the **organization** plugin (teams: `organization`, `member`, `invitation` tables) and the **apiKey** plugin (header-based keys for agents/CLI; each key's JSON metadata carries `{ workspaceId, actorType }`, locking it to one workspace).
- `packages/app` — a Nuxt 4 SPA (pages in `packages/app/app/pages/`, composables in `packages/app/app/composables/`). It talks to the API cross-origin with a session cookie.
- `packages/db` — Prisma 7. `packages/db/prisma/schema.prisma` holds the better-auth tables **plus hand-maintained Treehouse models** (`Workspace`, `FileNode`, `ChangeEvent`, `WorkspaceInvite`, `Share`, …). CRITICAL: never run `pnpm --filter api run auth:generate` — it regenerates the whole schema file and deletes the hand-maintained models. This plan requires no auth-config changes, so there is no reason to run it.
- `packages/cli`, `packages/desktop` — sync clients. They authenticate only with workspace-scoped API keys and reference only workspace ids (verified: no organization references in either), so they are untouched by this plan.

Key terms:

- **Organization ("org")**: a better-auth team — a row in the `organization` table plus `member` rows (`organizationId`, `userId`, `role`). Created invisibly at signup today.
- **Workspace**: the Treehouse file container — a row in the `workspace` table with `organizationId` pointing at its owning org. All file data, encryption keys, shares, and change feeds hang off `workspaceId`.
- **Shadow org**: (this plan's term) an organization that exists only to hold one workspace's member list. Never shown to users.
- **Active organization**: a better-auth session field (`session.activeOrganizationId`) selecting which org scopes the current session. This plan retires every use of it.
- **Invite link**: a Treehouse-specific shareable URL (`/invite/<token>`); the `workspace_invite` table stores the token's SHA-256, the workspace, and (denormalized) its org. Accepting creates a `member` row. This is distinct from better-auth's own email `invitation` table, which the product does not use.

Current behaviour, precisely (all paths repo-relative):

1. **Signup** (`packages/api/server/utils/auth.ts`, `provisionForNewUser`): creates an org (`"<name>'s Team"`), an owner `member` row, and a workspace named `"Default"`, then seeds it via `seedWorkspace` (`packages/api/server/utils/seed.ts`). Already 1:1 — this is the model we are generalising.
2. **Access check** (`packages/api/server/utils/workspace.ts`, `authorizeWorkspace`): loads the workspace, verifies an API key's `keyWorkspaceId` matches, then requires a `member` row for `(ws.organizationId, userId)`. This function is already correct for the target model and MUST NOT change.
3. **Workspace list** (`packages/api/server/routes/api/workspaces/index.get.ts`): cookie-only; lists workspaces of the **active org** via `activeOrgForUser` (`utils/workspace.ts`), which reads `session.activeOrganizationId` with a fallback to the user's first membership.
4. **Workspace create** (`packages/api/server/routes/api/workspaces/index.post.ts`): creates the workspace **inside the active org** and seeds it.
5. **Current workspace** (`packages/api/server/routes/api/workspace.get.ts`): API keys resolve their scoped workspace; cookie sessions call `currentWorkspaceForUser` → `resolveWorkspace(activeOrg)` (oldest workspace in the org, auto-creating "Default" if none).
6. **Invites**: `POST /api/invites` (`routes/api/invites/index.post.ts`) authorizes the workspace then stores `{ tokenHash, organizationId: ws.organizationId, workspaceId: ws.id, role: "member", … }`. `GET /api/invites/:token` (`[token]/index.get.ts`) previews (returns workspace + org + inviter names). `POST /api/invites/:token/accept` (`[token]/accept.post.ts`) checks existing membership of **`invite.organizationId`**, then race-safely claims a use and creates the `member` row in **`invite.organizationId`**. (The bold reads are the stale-org hazard this plan fixes.)
7. **Members** (`routes/api/workspaces/[workspaceId]/members.get.ts`): lists the workspace's org's members (id, name, image) for timeline attribution.
8. **Member removal** (`utils/auth.ts` organization plugin `afterRemoveMember` hook → `revokeWorkspaceKeysForMember` in `utils/workspace.ts`): deletes the removed user's API keys whose metadata `workspaceId` is one of the org's workspaces. Works unchanged under 1:1.
9. **MCP** (`packages/api/server/utils/mcp.ts`, `buildUserMcpServer`): `list_workspaces` already unions memberships; `create_workspace` creates in the user's **first** org.
10. **Web app**: `useWorkspaceData` (`packages/app/app/composables/useWorkspaceData.ts`) caches the workspace list keyed by the session's `activeOrganizationId`; `packages/app/app/pages/organizations.vue` is the better-auth starter page (create org / set active / email invite); links to it exist in `packages/app/app/components/AppSidebar.vue` (~line 412), `packages/app/app/layouts/default.vue` (~line 33), and `packages/app/app/pages/dashboard.vue` (~line 142, plus an "Active organization" debug display ~line 156); the invite accept page (`packages/app/app/pages/invite/[token].vue`) calls `authClient.organization.setActive(...)` on its CTA and shows the **org** name ("Join {{ preview.organizationName }}", ~line 322).
11. **better-auth reads headers** via `webHeaders(event)` (in `utils/workspace.ts`) — never `toWebRequest(event)` on body-carrying routes, which locks the body stream and hangs PUT/POST.

Tooling: run `vp check` (typecheck + lint) and `vp test` from the repo root for validation loops; `vp test --filter api` style filtering is available via `vp run`. The dev stack is `pnpm dev` (API on the worktree's Portless hostname; `pnpm env:status` prints URLs). `pnpm env:setup` prepares DB + .env without starting servers — enough for the API integration tests, which spin up against the worktree database.

## Plan of Work

The order is expand → migrate → contract: Milestones 1–2 make the code correct under BOTH data shapes (shared orgs and 1:1 shadow orgs), Milestone 3 changes the data, Milestones 4–5 remove what is then dead. Each milestone leaves `vp check` and `vp test` green and is separately committable.

### Milestone 1 — membership-based reads and workspace-resolved invite accept (API only)

Goal: no read path depends on the active organization, and no invite path trusts the denormalized org id. Behaviour for existing users is identical (their memberships' workspaces ARE their active org's workspaces today).

In `packages/api/server/utils/workspace.ts`:

- Add `workspacesForUser(userId: string)` — one query: `db.workspace.findMany({ where: { organization: { members: { some: { userId } } } }, orderBy: { createdAt: "asc" } })` (Prisma relation filter through `Workspace.organization` → better-auth's `Organization.members`; check the generated relation name on the `Organization` model in `packages/db/prisma/schema.prisma` — if the org model lacks a back-relation to `member`, fall back to the two-step query `member.findMany` then `workspace.findMany({ organizationId: { in } })` exactly as `buildUserMcpServer.list_workspaces` does today).
- Rewrite `currentWorkspaceForUser(ctx)` to return the oldest workspace from `workspacesForUser(ctx.userId)`, auto-provisioning (org + workspace + seed, as in Milestone 2's `createWorkspaceWithOrg`) if the user somehow has none. Delete its dependence on `activeOrgForUser`.
- Keep `activeOrgForUser` and `resolveWorkspace` in place until Milestone 5 (other call sites go away in Milestones 2 and 4); do not delete them yet.

In `packages/api/server/routes/api/workspaces/index.get.ts`: replace the `activeOrgForUser` + org-scoped query with `workspacesForUser(ctx.userId)`, same `select` and response shape (`{ workspaces: [...] }`).

In `packages/api/server/routes/api/invites/[token]/accept.post.ts`: after loading the invite, load its workspace (`db.workspace.findUnique({ where: { id: invite.workspaceId }, select: { organizationId: true } })`; 404 "Invite not found" if the workspace is gone) and use `workspace.organizationId` everywhere the handler currently uses `invite.organizationId` — the membership pre-check, the `member.create`, and the returned `organizationId` field. Keep the response shape (the app still receives `organizationId`; it stops using it in Milestone 4).

In `packages/api/server/routes/api/invites/[token]/index.get.ts`: resolve the displayed org name via the workspace's current org rather than `invite.organizationId` (or simply drop the org lookup and return `organizationName: null` — Milestone 4 stops displaying it; keeping the field avoids a lockstep deploy with the SPA).

Tests (extend `packages/api/test/invite-flow.test.ts`): seed an org with TWO workspaces A and B and a second shadow-org workspace C; assert (a) `GET /api/workspaces` as a member of both orgs returns A, B, C; (b) accepting an invite minted for A still works after A is manually reparented onto a fresh org mid-test (simulating the migration) — the accepter becomes a member of A's NEW org, not the invite's stored one.

Acceptance: `vp test` green; the two new assertions fail before the edits and pass after.

### Milestone 2 — workspace creation mints a shadow org

Goal: every NEW workspace is born 1:1 with its own org, from all three creation sites.

In `packages/api/server/utils/workspace.ts`, add one shared helper so the three sites cannot drift:

    export async function createWorkspaceWithOrg(args: {
      userId: string;
      name: string;
      icon?: string | null;
      color?: string | null;
    }): Promise<{ id: string; name: string; icon: string | null; color: string | null; theme: string | null; themeCss: string | null }>

It creates an `organization` row (name = the workspace name; better-auth's `slug` column, if present/required in the schema, gets a slugified name + short random suffix to satisfy uniqueness — check the `Organization` model in `packages/db/prisma/schema.prisma` for whether `slug` is required), an owner `member` row for `userId`, the `workspace` row pointing at it, then `seedWorkspace(ws.id)`. Use `randomUUID()` ids exactly as `provisionForNewUser` does today.

Call sites:

- `packages/api/server/routes/api/workspaces/index.post.ts`: drop `activeOrgForUser`; call the helper (caller becomes the workspace's owner). Response shape unchanged.
- `packages/api/server/utils/mcp.ts` `create_workspace` tool: drop the "first membership" org lookup; call the helper. Update the tool description ("Create a new workspace. You become its owner. …").
- `packages/api/server/utils/auth.ts` `provisionForNewUser`: reuse the helper; workspace (and org) named `` `${user.name}'s Workspace` `` falling back to `"My Workspace"`. Update the function's comment.

Tests: in `packages/api/test/` (extend an existing suite touching workspace creation, or the invite-flow suite): creating two workspaces as one user yields two distinct `organizationId`s, and the creator has an owner `member` row in each; a second user invited to workspace 1 does NOT gain access to workspace 2 (`authorizeWorkspace` 403s / `GET /api/workspaces` omits it).

Acceptance: `vp test` green; the cross-workspace isolation test fails before, passes after.

### Milestone 3 — data migration: split multi-workspace orgs

Goal: after this runs, every org has exactly one workspace, every member keeps exactly the workspaces they had, and no `workspace.id` changes.

Create a data-only Prisma migration (no schema change): from `packages/db`, run `pnpm prisma migrate dev --create-only --name split_orgs_one_per_workspace` (against the worktree database; `pnpm env:setup` first if needed), then replace the generated empty `migration.sql` with SQL that, in one transaction:

1. For every workspace that is NOT the oldest (`created_at`, tie-break by id) in its org: insert a new `organization` row (name/slug copied from the workspace's name, id via `gen_random_uuid()`), record the mapping in a temp table.
2. For each mapped (workspace → new org): copy every `member` row of the old org into the new org (`gen_random_uuid()` ids, same `user_id` and `role`), then `UPDATE workspace SET organization_id = <new org>`.
3. `UPDATE workspace_invite wi SET organization_id = w.organization_id FROM workspace w WHERE w.id = wi.workspace_id AND wi.organization_id <> w.organization_id;` (repairs all denormalized invite rows).
4. Rename leftovers: `UPDATE workspace w SET name = o.name FROM organization o WHERE o.id = w.organization_id AND w.name = 'Default';`

Check exact table/column names against `packages/db/prisma/schema.prisma` `@@map`/`@map` attributes before writing the SQL (Treehouse models map to snake_case table names like `workspace`; better-auth tables are typically lowercase model names — read the schema, do not guess).

The migration framework guarantees once-per-environment execution; the SQL itself must also be safe if the environment is already 1:1 (all four statements are natural no-ops then). Before running against production, snapshot: `pg_dump` the Railway database (connection string in the Railway service's `DATABASE_URL`) — and check whether prod even has a multi-workspace org: `SELECT organization_id, count(*) FROM workspace GROUP BY 1 HAVING count(*) > 1;`.

Validation: write a throwaway verification script or psql session against the worktree db seeded with a multi-workspace org (the Milestone 1 test seeds one — or insert by hand); after `pnpm prisma migrate dev`, assert: orgs are 1:1 with workspaces, previous members appear in every split org, `workspace_invite.organization_id` matches its workspace's org, workspace count and ids unchanged.

Acceptance: on a seeded scratch db the assertions above hold; `vp test` still green (tests run migrations from scratch, so new-world data is 1:1 from the start).

### Milestone 4 — UI contraction and per-workspace members

Goal: the word "organization" disappears from the product; member management lives on the workspace.

- Delete `packages/app/app/pages/organizations.vue`. Remove the links/nav items pointing at `/organizations` in `packages/app/app/components/AppSidebar.vue`, `packages/app/app/layouts/default.vue`, and `packages/app/app/pages/dashboard.vue`; remove the dashboard's "Active organization" display row and reword its invite card copy ("gets access to your workspaces" → "gets access to this workspace" / name the workspace).
- `packages/app/app/composables/useWorkspaceData.ts`: the list is no longer org-scoped, so drop `activeOrgId` and key the query as `["workspaces", userId]` (user id from the session; keeping user id in the key preserves the original reason it existed — a cache that survives login-as-someone-else). Also update the comment block, and re-check the "last opened" fallback (its "if it's still in the active org" comment) — the check becomes "still in the membership list".
- `packages/app/app/pages/invite/[token].vue`: delete `activateOrg` and the `authClient.organization.setActive` call (with membership-based listing there is nothing to activate — after accepting, `navigateTo(/w/<id>)` and an invalidated `["workspaces"]` query suffice; invalidate via `useQueryClient().invalidateQueries({ queryKey: ["workspaces"] })`). Change the heading to the workspace name (`preview.workspace.name`) instead of `preview.organizationName`.
- Members panel: add role to `GET /api/workspaces/:id/members` (`routes/api/workspaces/[workspaceId]/members.get.ts` — include `role: m.role`; keep omitting email) and add `DELETE /api/workspaces/:id/members/:userId` (new file `[userId].delete.ts` under a `members/` directory — move the GET to `members/index.get.ts`). The DELETE must be cookie-only (`requireCookieUser`), verify the CALLER's member row in the workspace's org has role `owner` or `admin`, forbid removing the last owner, then remove via better-auth so the key-revocation hook fires: `auth.api.removeMember({ headers: webHeaders(event), body: { memberIdOrEmail: <member row id>, organizationId: ws.organizationId } })`. (Use `webHeaders`, not `toWebRequest` — see Context.) In the app, surface it modestly: a "Members" item in the sidebar menu (where "Organizations" was) opening a panel listing members with avatar/name/role and a remove action for owners/admins, wired through `useTreehouseApi` (`packages/app/app/composables/useTreehouseApi.ts`).
- Keep `packages/app/app/composables/useAuthClient.ts`'s `organizationClient()` plugin registered (harmless, and `auth.api.removeMember` is server-side anyway); just update its comment. Update `packages/app/app/pages/index.vue`'s marketing bullet ("organizations for teams" → "invite your team to a workspace").

Tests: API tests for the DELETE route (member removal revokes that member's workspace-scoped key — mirror `packages/api/test/member-revocation.test.ts`; non-admin gets 403; last owner is protected).

Acceptance (visual — mandatory per `CLAUDE.md`): run `pnpm dev`, then with `agent-browser` (close any existing daemon first): sign up user A → dashboard shows no organization text → create workspace 2 → switcher shows both → invite from workspace 1 → accept as user B in a fresh session → B sees ONLY workspace 1 → A opens Members, sees B, removes B → B's next `/api/workspaces` omits workspace 1. Screenshot dashboard, switcher, invite page, members panel.

### Milestone 5 — cleanup, docs, retrospective

- Delete `activeOrgForUser` from `packages/api/server/utils/workspace.ts`; fold `resolveWorkspace` into `currentWorkspaceForUser` (its only remaining caller) or keep it if the seed/device flow still uses it — verify with a grep for both names and delete whatever is now uncalled. Remove `activeOrganizationId` from `RequestPrincipal` and the two places that populate it (`authenticate`, `requireCookieUser`) once nothing reads it. `GET /api/me` (`routes/api/me.get.ts`) may keep returning `activeOrganizationId` for shape stability — but nothing consumes it; prefer removing the field in the same pass since the SPA deploys atomically with the API here (both ship from this repo; the only consumers are this app and the untouched CLI/desktop, which never call `/api/me`).
- Update `CONCEPTS.md`'s Workspace entry: "the unit of file storage, membership, and collaboration; each workspace's member list is implemented as a hidden 1:1 better-auth organization (a 'shadow org') — organizations are an implementation detail and never user-facing." Update the `WorkspaceInvite` comment in `packages/db/prisma/schema.prisma` (line ~370: "Joining this org…" → note the org id is denormalized display data; access resolves through the workspace). Update `CLAUDE.md`'s packages/api description if it mentions organizations UI.
- Sweep remaining copy: `grep -rn "organization" packages/app/app packages/api/server --include='*.vue' --include='*.ts'` and judge each survivor (internal comments naming the shadow-org mechanism are fine; user-visible strings are not).
- `vp check`, `vp fmt`, `vp test`; write `Outcomes & Retrospective`.

## Concrete Steps

All commands from the repo root unless stated.

    vp check --no-fmt        # typecheck + lint (run after every milestone)
    vp fmt --check <paths>   # format check, scoped — `vp check`'s fmt stage has 4 pre-existing failures (see Surprises)
    vp test                  # full test suite (HTTP-gated api suites SKIP without a running server)
    pnpm env:setup           # prepare this worktree's db + .env (no servers) — needed before api tests / migrations
    pnpm dev                 # full stack, for Milestone 4 visual verification (pnpm env:status prints the URLs)

To actually RUN the HTTP-gated api suites (`invite-flow`, `members-routes`, `mcp`, `files-routes`, `device-flow`, …), do NOT use `pnpm dev:api` — it overrides `BETTER_AUTH_URL` with the worktree's https Portless URL, which flips better-auth into secure-cookie mode and 401s every cookie the in-process test helpers mint. Start the raw server so it uses `packages/api/.env`'s `BETTER_AUTH_URL=http://localhost:3010`, and disable the device-poll slow-down guard that `device-flow.test.ts` trips over:

    cd packages/api && DEVICE_POLL_INTERVAL_S=0 node ../../node_modules/.bin/nitro dev --port 3010
    # then, from the repo root:
    SMOKE_BASE=http://localhost:3010 vp test

Milestone 3 migration authoring (from `packages/db`):

    pnpm prisma migrate dev --create-only --name split_orgs_one_per_workspace
    # edit prisma/migrations/<timestamp>_split_orgs_one_per_workspace/migration.sql (SQL per Milestone 3)
    pnpm prisma migrate deploy  # applies to the worktree db WITHOUT drift detection
                                # (`migrate dev` offers to RESET the database if it sees scratch tables)

Production check + backup before deploying Milestone 3 (connection string from Railway's DATABASE_URL). NOT performed by the implementation session — this is for whoever deploys:

    psql "$DATABASE_URL" -c "SELECT organization_id, count(*) FROM workspace GROUP BY 1 HAVING count(*) > 1;"
    pg_dump "$DATABASE_URL" > treehouse-pre-org-split.sql

## Validation and Acceptance

Per-milestone acceptance is stated inline above. End-to-end acceptance for the whole plan:

1. Fresh signup lands with a workspace named "<Name>'s Workspace"; no organization appears anywhere in the UI.
2. Creating a second workspace and inviting user B to the FIRST grants B only the first (B's switcher and `GET /api/workspaces` show one workspace; `GET /api/workspaces/<second>/...` returns 403 for B).
3. A pre-existing workspace-scoped API key (mint one before running the Milestone 3 migration in a dev rehearsal) still reads and writes its workspace afterwards.
4. An invite link minted BEFORE the migration, accepted AFTER it, grants the workspace it displays (covered by the Milestone 1 reparenting test, and worth one manual rehearsal).
5. Removing a member from a workspace revokes their key for that workspace only (`member-revocation` behaviour preserved).
6. `vp check` and `vp test` pass; the visual walkthrough in Milestone 4 was actually performed and screenshotted (if any part could not be looked at, the final report must say so plainly).

Status as implemented (2026-08-25): items 2, 3, 4 and 5 are proven — 2 by `invite-flow.test.ts` "inviting someone to ONE created workspace does not hand them the other" and by the Milestone 3 rehearsal, 3 and 4 by the rehearsal transcript in Artifacts, 5 by `members-routes.test.ts` "an owner removes a member, revoking that member's workspace key". Item 1's workspace naming is proven by `auth-api-key.test.ts` and `workspace-membership.test.ts`, and "no organization appears anywhere in the UI" is proven by grep and by the deleted page — but NOT by looking. Item 6's `vp check`/`vp test` half passes; **its visual half was not performed** (see Outcomes & Retrospective).

## Idempotence and Recovery

Milestones 1–2 are pure code changes, safe to re-run/re-apply, and are individually revertable commits; each is compatible with both pre- and post-migration data, so a rollback of any later milestone never strands the code. The Milestone 3 migration runs once per environment via Prisma's migration table; its statements are no-ops on already-1:1 data. Recovery from a bad prod migration is the `pg_dump` snapshot taken immediately before deploy. The migration never deletes or merges rows (it only inserts orgs/members and updates two foreign keys plus names), so even a logic error cannot destroy file data; workspace ids are never touched. If the split produces a wrong membership, the fix is corrective SQL on `member` rows — file data is unaffected.

## Artifacts and Notes

### Milestone 3 migration validation (worktree database, 2026-08-25)

The worktree database already held 1,427 workspaces across 1,334 organizations, 90 of which owned more than one workspace (accumulated by the API test suites). On top of that it was seeded with an explicit scenario: organization `mig_org_A` "Acme Team" with two members (owner `mig_user_x`, member `mig_user_y`) and three workspaces (`mig_ws_1` "Default" oldest, `mig_ws_2` "Notes", `mig_ws_3` "Default" newest); an already-1:1 organization `mig_org_B` "Solo Team" with one workspace; and two invite links, one on the workspace that stays put and one on a workspace that gets re-parented. A `migcheck` schema captured the pre-migration `(userId, workspaceId)` access map, workspace rows, and invite rows.

`pnpm prisma migrate deploy` then produced:

    === A1: every organization now owns at most one workspace ===
     orgs_with_multiple_workspaces
                                 0

    === A2: workspace ids and count are unchanged ===
     after_count | before_count | id_set_differences
            1427 |         1427 |                  0

    === A3: the (user, workspace) access map is IDENTICAL before and after ===
     access_lost | access_gained | access_pairs_after
               0 |             0 |               1020

    === A4: no invite row disagrees with its workspace any more ===
     stale_invites
                 0          (was 5 before the migration)

    === A5: no workspace is still called "Default" ===
     default_named
                 0

    === A6: the seeded scenario, in detail ===
         id      |            organizationId            |   name    | org_name  | slug
     mig_ws_1    | mig_org_A                            | Acme Team | Acme Team |
     mig_ws_2    | 245e3493-29f6-4e4b-8bd0-095509c964fb | Notes     | Notes     |
     mig_ws_3    | 21e9b36d-82cc-47e8-9082-47d79bdb3fd0 | Acme Team | Acme Team |
     mig_ws_solo | mig_org_B                            | Solo      | Solo Team |

    === A7: members were copied into every split-off organization ===
      workspace  |   userId   |  role
     mig_ws_1    | mig_user_x | owner
     mig_ws_1    | mig_user_y | member
     mig_ws_2    | mig_user_x | owner
     mig_ws_2    | mig_user_y | member
     mig_ws_3    | mig_user_x | owner
     mig_ws_3    | mig_user_y | member
     mig_ws_solo | mig_user_z | owner

    === A8: the already-1:1 organization was left completely alone ===
         id      | org_unchanged | name_unchanged
     mig_ws_solo | t             | t

(A6 shows the accepted cosmetic edge case from the Decision Log: two workspaces both originally named "Default" both end up named "Acme Team".)

Re-running the same SQL a second time against the now-1:1 database is a true no-op:

    UPDATE 0 / SELECT 0 / INSERT 0 0 / INSERT 0 0 / UPDATE 0 / UPDATE 0
     ws_changed | ws_added | mem_lost | mem_added
              0 |        0 |        0 |         0

The migration also applies cleanly from scratch: `DROP/CREATE DATABASE treehouse_migscratch` then `DATABASE_URL=… pnpm prisma migrate deploy` → "All migrations have been successfully applied" (18 migrations).

### Milestone 3 backwards-compatibility rehearsal

A throwaway script minted a workspace-scoped API key and an invite link on a workspace inside a two-workspace organization, ran the split SQL, and then exercised both:

    PRE  key list: 200
    re-parented: true | ws name: "Second"
    POST key list: 200
    POST accept: 200 -> org CURRENT (correct)
    joiner sees wsB: true | joiner sees wsA: false (must be false)

That covers end-to-end acceptance items 2, 3 and 4: a key minted before the split still reads its workspace afterwards; an invite link minted before the split, accepted after it, joins the workspace's CURRENT organization; and the accepter gets that workspace only, not its former sibling.

The invariant that makes backwards compatibility hold, stated once for the implementer: **external references are workspace ids and opaque tokens; org ids never leave the server** (the one exception, the invite accept response's `organizationId` field, stops being consumed in Milestone 4). API keys (`{ workspaceId }` metadata), CLI sync links, desktop device grants, share links, encryption keys, and read states all key off `workspaceId` and are untouched by re-parenting a workspace onto a new org with copied members.

## Interfaces and Dependencies

No new dependencies. better-auth's organization + apiKey plugins stay exactly as configured in `packages/api/server/utils/auth.ts` (no config change → no `auth:generate` → the hand-maintained schema is safe). At completion the following exist:

In `packages/api/server/utils/workspace.ts`:

    export async function workspacesForUser(userId: string): Promise<Workspace[]>
    export async function createWorkspaceWithOrg(args: { userId: string; name: string; icon?: string | null; color?: string | null }): Promise<Workspace>
    export async function currentWorkspaceForUser(ctx: RequestPrincipal): Promise<Workspace>  // membership-based
    // authorizeWorkspace, mintWorkspaceKey, revokeWorkspaceKeysForMember: unchanged signatures
    // activeOrgForUser and resolveWorkspace: DELETED by Milestone 5 (both uncalled)
    // RequestPrincipal no longer carries activeOrganizationId

As implemented, both helpers return full `Workspace` rows (the list route projects the six display fields itself), and `createWorkspaceWithOrg` derives the shadow organization's unique `slug` from the workspace name plus 8 hex characters of a UUID.

New route: `DELETE /api/workspaces/:workspaceId/members/:userId` (cookie-only; owner/admin caller; an admin may not remove an owner; the last owner may not be removed; delegates to `auth.api.removeMember` so the key-revocation hook fires). Returns `{ ok: true, removedUserId }`. Changed route bodies (shapes preserved): `GET /api/workspaces`, `POST /api/workspaces`, `GET /api/workspace`, `POST /api/invites/:token/accept`, `GET /api/invites/:token`, `GET /api/workspaces/:id/members` (adds `role`). One shape DID change: `GET /api/me` no longer returns `session.activeOrganizationId` — verified unconsumed by grep across every package.

New app component: `packages/app/app/components/WorkspaceMembers.vue`, opened from the sidebar account menu. New client method: `useTreehouseApi().removeMember(workspaceId, userId)`.

## Revision note (2026-08-25, implementation session)

This revision records the plan being carried out end to end. `Progress` now marks Milestones 1–5 done with timestamps and states plainly what was NOT done (the browser walkthrough, and the production migration). `Surprises & Discoveries` gained five entries, the most consequential being that `pnpm dev:api` cannot serve the HTTP-gated test suites because of a `BETTER_AUTH_URL` scheme mismatch — without that, a reader would conclude those tests are broken. `Decision Log` gained nine implementation decisions, notably moving `createWorkspaceWithOrg` into Milestone 1 (Milestone 1's own auto-provisioning needs it), putting the core assertions in a new in-process suite (the HTTP suites silently skip in CI), reordering the migration's rename step ahead of the split, and leaving split-org slugs NULL. `Artifacts and Notes` now carries the migration's before/after SQL transcripts and the backwards-compatibility rehearsal, which are the evidence for end-to-end acceptance items 2–5. `Concrete Steps`, `Validation and Acceptance` and `Interfaces and Dependencies` were corrected to match what actually exists and what actually works, so the next contributor does not repeat the `pnpm dev:api` and `prisma migrate dev` dead ends. `Outcomes & Retrospective` was written.

### 2026-08-25 19:0xZ — Visual verification performed (parent session)

The deferred Milestone 4 acceptance walkthrough was executed in full against the worktree dev stack (`pnpm dev`, app at the worktree's Portless URL) with `agent-browser`, two isolated sessions (user A "Alice Verify", user B "Bob Guest"):

- Signup gave Alice a workspace named "Alice Verify's Workspace"; dashboard, sidebar and account menu show no organization text; the account menu shows "Members" where "Organizations" was. Screenshots: /tmp/th-verify-dashboard.png, /tmp/th-verify-members-solo.png.
- Created "Secret Project"; switcher lists both workspaces.
- Invite minted from workspace 1 ("Invite someone to Alice Verify's Workspace"); Bob signed up, opened the link, saw "Join Alice Verify's Workspace … You'll share its files and sync with everyone in it — and nothing else", accepted, and landed in /w/<ws1>. Bob's `GET /api/workspaces` returned exactly [Alice's workspace, Bob's own]; `GET /api/workspaces/<secret-project>/list` returned 403. Screenshots: /tmp/th-verify-invite-accept.png, /tmp/th-verify-bob-switcher2.png.
- Alice's Members panel showed Alice (Owner, no Remove on self) and Bob (Member, Remove). Removing Bob raised a confirm dialog ("…any folder they sync from it will stop syncing"), after which Bob's list dropped to his own workspace and workspace 1 returned 403 for him. Screenshots: /tmp/th-verify-members-two.png, /tmp/th-verify-members-after-remove.png.
- One false alarm during the walkthrough: invite-page buttons appeared not to respond to automated clicks. Root cause was the Nuxt DevTools overlay intercepting Playwright's pointer events in the dev build — JS-dispatched clicks and real usage are unaffected, and the overlay does not exist in production builds. Not a defect.
- Minor UX observation (pre-existing, out of scope): a logged-out user opening an invite link who signs UP (rather than in) lands on their new dashboard instead of returning to the invite; they must re-open the link. The sign-IN path preserves the redirect.

With this, acceptance items 1 and 6 are fully met; end-to-end acceptance is complete. Production rollout (pg_dump snapshot + `prisma migrate deploy` on Railway) remains the only outstanding step.