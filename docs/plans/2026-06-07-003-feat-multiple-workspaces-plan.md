---
title: "feat: Multiple workspaces — switcher + emoji/icon + colour"
type: feat
status: active
date: 2026-06-07
---

# feat: Multiple workspaces — switcher + emoji/icon + colour

## Summary

Let an org have many workspaces, switch between them from the sidebar, and give
each a customizable icon (emoji **or** an Iconify/Solar icon) + background colour.
The URL already carries the workspace id (`/w/<id>/<path>`), so switching is just
"list → navigate". Builds on the Solar-icons work.

## Why this shape

- **Authz already per-workspace** — `authorizeWorkspace(ctx, id)` checks the
  workspace exists and the user is a member of its org. File/list/changes routes
  already work for any accessible workspace.
- **The URL is the selector** — no server-side "active workspace" pointer needed
  (unlike active-org). The switcher navigates to `/w/<otherId>`.
- **Creating a workspace is a human/session action** — API keys are scoped to one
  workspace, so agents operate _within_ a workspace (same shape as org creation).

## Schema (hand-maintained Workspace model)

Add two nullable columns (no `auth:generate`; manual edit + `prisma:migrate`):

- `icon String?` — an emoji (e.g. `🌳`) **or** an Iconify name (e.g.
  `solar:folder-bold-duotone`). Detected by the presence of `:`.
- `color String?` — a palette token (e.g. `blue`) for the icon-tile background.

## API (new routes)

- `GET  /api/workspaces` — list workspaces in the caller's active org (cookie
  session; member check). Returns `[{ id, name, icon, color }]`.
- `POST /api/workspaces` — create `{ name, icon?, color? }` in the active org
  (cookie session only).
- `GET  /api/workspaces/[id]` — metadata `{ id, name, icon, color }` via
  `authorizeWorkspace` (fills the gap where the app faked the name from the
  default workspace).
- `PATCH /api/workspaces/[id]` — update `{ name?, icon?, color? }`
  (`authorizeWorkspace`).

Existing `/api/workspaces/[id]/{files,list,changes,move}` and `/api/workspace`
(default, used by the `/workspace` redirect) are unchanged.

## Frontend

- `useTreehouseApi`: `listWorkspaces`, `createWorkspace`, `getWorkspaceById`,
  `updateWorkspace`.
- `useWorkspaceData`: fetch the **specific** workspace by id (route id) for
  name/icon/colour, plus a `workspaces` list query for the switcher.
- **WorkspaceSwitcher** (replaces the sidebar identity button): shows the current
  workspace's icon-tile + name; opens a menu listing all workspaces (each
  navigates to `/w/<id>`), with "New workspace" and "Customize".
- **WorkspaceIcon** component: renders an emoji char or an Iconify icon on a
  coloured rounded tile. User-chosen icons render at **runtime via `@iconify/vue`**
  (`<Icon>`, Iconify API + cache) — unplugin-icons stays for build-time chrome.
- **IconPicker** (shared, reused for files later): emoji input + Solar icon
  search (Iconify API) + colour swatches. Used in create + customize.

## Units

- U1. Schema + migration (`icon`, `color` on Workspace).
- U2. Workspace CRUD endpoints (list/create/get/patch) + authz.
- U3. API client + `useWorkspaceData` by-id metadata + workspaces list query.
- U4. WorkspaceIcon + WorkspaceSwitcher (list/switch/create-minimal).
- U5. IconPicker + customize/create dialog (emoji + Solar + colour).

## Scope boundaries

- No workspace delete/archive yet (add later; needs a confirm + data handling).
- No per-file/folder icons (next plan; reuses IconPicker + a node-meta table).
- No workspace slugs in the URL (id only for now).
- Icons render via the Iconify runtime API; self-hosting/bundling Solar for
  offline is a later optimization.

## Verification

- `vp check` + tests green; Cloudflare build clean.
- Create a 2nd workspace, switch via the sidebar, set emoji/icon + colour, deep
  link to `/w/<id2>/<file>`; confirm files/activity/keys are correctly scoped.