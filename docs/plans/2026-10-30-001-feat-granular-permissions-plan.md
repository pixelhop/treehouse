---
title: Granular permissions (Viewer role, scoped keys, folder and file grants)
status: in-progress
created: 2026-10-30
---

# Granular permissions

Three stacked PRs on one shared access engine:

1. **Access engine + Viewer role.** Generalises `NodeAcl` into grants, routes every surface through one evaluator, and adds a read-only member role.
2. **Scoped agent keys.** Keys can be read-only and/or limited to one folder.
3. **Folder and file grants to specific members.** Viewer or Editor access, per person.

## Access-model decisions

### The evaluator

One pure function decides everything:

```
level(path, subject) = min( nodeLevel(restrictions, path, subject.userId),
                            roleCap(subject.role),
                            keyCap(subject.keyScope, path) )
```

with `none < read < write`.

- **`nodeLevel`: open by default.**
  - Find the most specific restriction covering the path. A file restriction covers that exact path. A folder restriction covers the folder and everything under `folder/`, with sibling-prefix safety kept.
  - If there is no restriction, the level is `write`.
  - If there is one, the caller's level is their own user grant on it. Failing that, the restriction's "everyone" grant. Failing that, `none`.
  - Grants on less specific ancestors do not apply. "Most specific wins" is today's rule, and it lets a nested restriction stand on its own.
- **`roleCap`.** `viewer` → `read`. owner, admin and member → `write`.
  - **Owners and admins get no bypass.** A restricted folder is invisible to them unless they hold a grant.
- **`keyCap`.**
  - No key (a cookie session) → `write`.
  - Key with a folder, path outside it → `none`.
  - Read-only key → `read`.
  - Otherwise → `write`.
- **A key never exceeds its creator.** The user term is always evaluated for the key's owner (`referenceId`), with their current role and grants. The cap can only narrow it.
  - Everything is evaluated on every request, so demoting a member, or removing their grant, narrows their keys immediately.
- **Fail closed.** These all deny:
  - a path that won't normalise;
  - a missing subject on a governed path;
  - an unknown role string (treated as `viewer`);
  - a malformed key scope (treated as read-only with no folder access: `none`).
- **Trusted callers are explicit.** The file service takes `viewer: AccessSubject | "trusted"` instead of today's `actorId?: string`, where `undefined` meant trusted. That makes forgetting the subject a type error, not a silent bypass.

### Storage

- **`NodeAcl` becomes the restriction row.** It keeps the `path` and `kind` it has today.
- **A new `NodeGrant` table holds the "who" and "what level".** Each row is `(aclId → NodeAcl, cascade, subject: "user" | "everyone", userId?, level: "none" | "read" | "write")`.
  - A restriction with no grants means **nobody**, not "everybody". So a restriction can never fall open by losing its rows. That is the safe direction for an orphan.
- **Keys are not grant rows.** A key's scope `{ access: "read" | "write", folder: string | null }` lives in its better-auth metadata, next to `workspaceId` and `actorType`. Reasons:
  - It is only ever a cap.
  - It is created atomically with the key.
  - It dies with the key.
  - It is immutable: to change scope, mint a new key.

  The same evaluator consumes it.

- **Migration.** Each existing `NodeAcl(ownerId)` row gets one `NodeGrant(user = ownerId, write)`.
  - `ownerId` becomes nullable and is no longer read.
  - It is kept for one release so a rollback or a mid-deploy old instance still sees the old private rows, and fails closed on new ones (a null owner matches nobody).
  - A follow-up drops it.
- **Known and accepted: the deploy window.** Migrations run in Canine's predeploy Job while old pods still serve. A node made private by an old pod after the backfill has a row with no grant, so it admits nobody, its creator included. Agreed with the user on 2026-10-30 to accept this rather than add a trigger: the window is short, and PR 3's owner claim recovers any such file.
- **Private is a special case of grants.** "Private" means a restriction whose only grant is `me: write` (only me and my agents). The existing Private toggle, MCP `set_private` tool, and lock badge keep working. They create and recognise that shape.

### The Viewer role

- A member role (`viewer`) stored on the hidden organization's `Member.role`, like the other roles.
  - Enforcement is entirely Treehouse's evaluator, so the better-auth org config is untouched: no `auth:generate`, no scratch-file merge.
  - better-auth's own org endpoints treat an unknown role as having no permissions, which is the safe default.
- **A Viewer can read** everything the grants let them see, including:
  - the tree, files and search;
  - history (they can view old versions);
  - activity and the change feed;
  - sync (pull only).
- **A Viewer cannot:**
  - write, create, upload, edit or move files;
  - delete or restore files;
  - change icons or order;
  - make things private or change grants;
  - create, edit or revoke share links;
  - rename or re-icon the workspace;
  - create invite links;
  - change roles.
- **Comments are allowed.**
  - A comment is not a change to the workspace's files. It lives in its own table and never touches file bytes or structure.
  - Reviewing is the main reason to invite a viewer. A client reads the proposal and leaves comments on it.
  - Viewers can also reply and resolve, because resolution is part of the review conversation, not of the file.
  - The same rule applies to read-only keys, so a review agent can leave comments.
- **Changing roles.** A new cookie-only endpoint, `PUT /api/workspaces/:id/members/:userId` with `{ role }`.
  - Owners and admins can set `member` or `viewer`.
  - Only an owner can change an existing admin. Nobody can change an owner's role, or their own role.
  - The endpoint can't grant `admin` or `owner`. Nothing in the product mints admins today, and a reachable admin could call better-auth's own `organization/update-member-role`, which knows nothing of these rules. Leaving admin out removes that bypass instead of guarding it.
- **Invite links carry a role.**
  - Viewers can't mint invite links.
  - Members can mint `member` or `viewer` links.

### Errors: a clear rejection type

- **Hidden** (the grants say `none` and you aren't the key-folder case): **404**, exactly as today. Existence is never disclosed.
- **Visible but not writable**: **409** with `{ error: "read_only", reason: "role" | "key" | "grant" }`.
  - It is deliberately **not 403**. Fielded sync clients turn any 403 into terminal `auth-lost` for the whole folder (`packages/cli/src/api-client.ts` `assertAuthed`).
  - It is distinct from the version conflict, which is 412.
- **Outside a folder-scoped key's folder**: **409** with `{ error: "outside_key_folder", folder }`.
  - This is reported regardless of whether the path exists, so it reveals nothing. The key's folder is already known to whoever holds it.
- **MCP** returns the same distinction as text: "This key is read-only", "You have view-only access to this workspace", "Outside this key's folder (clients/acme)", or "Not found".

### Must stay consistent everywhere (all through `acl.ts`)

| Surface                                                      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tree and list                                                | Filtered by `read`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Read                                                         | Filtered by `read`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Search                                                       | Filtered by `read`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Version history                                              | Filtered by `read`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `file-read-state`                                            | Filtered by `read`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Comments                                                     | Read access to the file.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Write, edit, move, move-folder, delete, restore, icon, order | Need `write` on the path, plus `write` on the destination for moves.                                                                                                                                                                                                                                                                                                                                                                                 |
| Private and grants                                           | Need `write` on the node, and not a Viewer. Grant changes also need the caller to keep `write` after the change, so you can't orphan a node by accident.                                                                                                                                                                                                                                                                                             |
| Share links                                                  | A restricted node, or anything under one, cannot get a share link, public or member. A public link bypasses grants entirely, so allowing it would make the restriction meaningless. Existing links go dead while the node is restricted, and come back if the restriction is lifted (today's private behaviour). Creating or revoking links needs `write` and a non-viewer role.                                                                     |
| Change feed and activity                                     | File and comment events show only if you can read the path. `access_revoked` goes to subjects who could read the path before and can't now, using the grants recorded on the event. `access_granted` goes to those who can, except the actor. Any change to a restriction's grants emits both in one transaction, and each client gets the one that applies to it. The revoked marker reveals only a path the recipient could see until that moment. |
| Synced folders                                               | Losing access removes local files and regaining access brings them back, as private does today. A read-only rejection triggers "revert and notify", below.                                                                                                                                                                                                                                                                                           |
| MCP                                                          | Both registration surfaces (`buildMcpServer` and `buildUserMcpServer`) build their actor from the per-workspace subject.                                                                                                                                                                                                                                                                                                                             |

**Threads in flight.** Trash, point-in-time restore and undo merged to `main` first (#142 to #144), so PR 1 moved them onto the engine: viewers can list the trash (read) but can't preview or apply a recovery. Recovery still reasons about a single owner (`privateTo`), which `restrictionOwner` bridges, so PR 3 has to extend it before a restriction can have several grantees. Backlinks and tags (#141, #146) are still open: whoever merges second rebases and routes their checks through `acl.ts` (`canRead` / `canWrite` with an `AccessSubject`).

### Sync with read access: revert and notify

- **The client recognises `read_only` / `outside_key_folder`** as a typed `PutReadOnly` result.
- **Edits.** The client restores the server version, using the same atomic replace and baseline update as a pull. So the watcher echo is a no-op and the next reconcile sees nothing to push. Nothing loops, and no conflicted copy is made.
  - The reverted local bytes are copied to `.treehouse/reverted/`, named by their content, inside the folder, which never syncs. The notice says where. "Never lose data" stays true locally too: a later edit can't replace an earlier one.
  - A file with no baseline that exists on both sides, as when a populated folder is linked, is treated as an edit. Treating it as new would leave it without a baseline, so it would never receive another update.
- **Deletes.** The client re-downloads the file.
- **New local files** in a place you can't write: the client leaves them in place, does not upload them, and remembers the path with its mtime and size so they aren't offered again until the file changes. The memory lasts for the daemon's lifetime, on purpose: a restart offers each file once more, which is how they upload by themselves after the member is given write access.
- **Where it shows.** A line in the sync log, a `notices` list in the daemon's status reply, and a notice in the desktop tray menu ("1 change reverted: you have view-only access").

### Orphaned restrictions (needs agreement before building)

**The failure.** Every grantee of a restricted node leaves the workspace. Today's private files already have this problem: an ACL left pointing at a removed user. The files are invisible to everyone forever, still count against storage, and the path can't be reused.

**Proposed recovery.**

- Workspace owners see a list of restricted nodes with no remaining member grantee. They see the name only, never contents.
- They can **claim** one. The claim adds the owner as an Editor grantee and records an `access_claimed` event in the activity feed, so the claim is visible to the workspace.
- The cost is about one endpoint, one panel and one op.

## PR breakdown

### PR 1: access engine + Viewer

- Schema and migration: `NodeGrant`, and `ownerId` nullable.
- `acl.ts` rewritten around `AccessSubject` / `Restriction`, with table-driven tests.
- `authorizeWorkspace` returns the subject.
- `files.ts` takes `viewer` / `actor.access`.
- Every route listed above, the MCP servers, the role endpoint, and invite roles.
- App:
  - a role picker in the members panel and the invite role;
  - a read-only workspace UI that hides or disables write affordances;
  - a Viewer badge.
- CLI and desktop: revert and notify.
- Docs: invite people and roles, private files, MCP reference, REST API, how sync works.

### PR 2: scoped keys

- Key scope in metadata, read by `authenticate`.
- Create a key with `{ access, folder }` (REST and app).
- The device approval screen offers read-only and a folder.
- The MCP server instructions and `list_members` / `whoami`-style output say what the key can do.
- `/api/auth/*` rejects `x-api-key`.
  - Today `enableSessionForAPIKeys` lets a key call better-auth's own `api-key/create` as a session. A read-only key could mint itself an unscoped one, which would make scoping pointless. That is a concrete and likely escalation, and the fix is about 10 lines.
- Docs: API keys, authentication.

### PR 3: member grants

- `PUT /api/workspaces/:id/node-access` with `{ path, kind, everyone, grants: [{ userId, level }] }`.
- The list API returns the restrictions the caller can see, with their grantees.
- App: a "Share with people" access dialog: Viewer or Editor per member, "everyone else" no access or can view, and the lock badge shows the restricted state.
- MCP: a `get_access` description in `list`.
- The orphan-claim flow, if agreed.
- Docs: private files becomes "Private and restricted files".

## Verification

- `vp check`, `vp test` (API integration tests across REST and MCP for each role, key scope and grant), and `pnpm fallow:audit`.
- `pnpm dev` with agent-browser: an owner, a member and a viewer account, a scoped key over MCP, and the CLI syncing a read-only folder.
- Screenshots go in each PR, which also says plainly what couldn't be verified.