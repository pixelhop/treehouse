# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Workspace & sharing

### Workspace

The unit of file storage, membership, and collaboration — a namespace of files that human members and their agents share, and the only container users ever see. Each Workspace has its own members, roles (owner/admin/member/viewer) and invite links: being invited to one Workspace grants that Workspace and nothing else. An agent/CLI credential is scoped to exactly one Workspace.

Under the hood a Workspace's member list is implemented as a hidden 1:1 better-auth organization (a "shadow org"), which is what supplies member rows, roles, and the removal hook that revokes an ex-member's sync keys. Organizations are an implementation detail and are never user-facing — there is no organization switching, no "active organization", and no organizations screen.

### Viewer

A member role that can read whatever the [[Grant]]s let them see, comment, and sync, but change nothing. Capped the same way on every surface, and for every API key the member holds. A write they attempt is refused with `read_only`, distinct from a version conflict: sync clients revert it rather than retry it.

### Restriction

A rule on one file or folder (and its subtree) saying only its [[Grant]]s may reach it. Everything is open to every member unless restricted; the most specific restriction covering a path wins and replaces any above it. A restriction with no grants admits nobody, so it can only ever fail closed. Owners and admins get no bypass.

### Grant

One entry on a [[Restriction]]: who (a member, or everyone else) and how far (none, read or write). "Private" is the special case of a restriction whose only grant is its creator at write.

### Share

A grant of read access to a single file or a whole folder within a Workspace, created by a member. A Share has an access model (Member link or Public link), a kind (file or folder), and may carry a password and a pinned version.

A Share is revocable, not deleted: revoking sets a timestamp and every read re-checks it, so a revoked link stops working immediately even for someone who already passed its password gate. A folder Share covers the folder and its entire subtree, and never a sibling that merely shares the path prefix.

### Member link

A Share whose access model is a deep link into the app that still requires the opener to be a logged-in member of the Workspace — it adds no new access, just a shareable address. Both humans (via the UI) and agents (via MCP) can mint one.

### Public link

A Share whose access model is an unguessable token granting read access with no login. Public links are read-only, optionally password-protected, and may only be minted from a human session (never an agent/CLI credential). Opening one never exposes anything outside the shared file or folder subtree.

### Version permalink

A Public (or file) link pinned to the exact bytes of one version of a file, so the link keeps serving those bytes even after the file changes — and reports the version as unavailable rather than silently serving something else if those bytes are gone. Folder and unpinned links instead always resolve to the latest content (live).

## Comments & review

### Comment thread

An anchored conversation on a file: a member or agent comments on a selected text range (or a cursor point), others reply, and any member or agent may resolve or reopen it — every entry attributed by credential, nothing ever deleted. A thread records the exact file version it was written against plus the quoted text and surrounding context, and re-attaches to newer versions by matching that text, never by stored offsets.

### Outdated thread

A [[Comment thread]] whose anchor text no longer confidently matches the current version after a rewrite — either not found at all (outdated) or matching several places equally well (ambiguous; never guessed into one). Outdated is independent of resolved: an outdated thread can still be replied to, resolved, or reopened. It leaves the document margin for an outdated tray, and can always be opened against the version it was written on, rendered in place.

## Desktop sync & onboarding

### Linked folder

A local directory registered for two-way sync with exactly one Workspace, recorded in the daemon's shared registry with optional attribution (which surface created it — app or CLI — which account, and the minted key's identity). Attribution scopes destructive actions: the desktop app's sign-out pauses and revokes only the links it owns, never CLI-created ones. Distinct from the [[Member link]]/[[Public link]] Share family — a Linked folder grants sync, not viewing access.

### Device grant

The named process by which a client with no credentials obtains a Workspace-scoped key: the client requests a short user code, the user approves it in an authenticated web session choosing the Workspace, and the client receives the key (with its revocation handle) exactly once by polling. Both the CLI and the desktop app onboard through the same grant; the approval always binds the key to a single Workspace.

### Descriptor

The small public document a deployment's app origin serves at a fixed well-known path, naming the API origin that serves it. It is how a client holding only an app address (from an invite link, or pasted by a self-hoster) discovers where to authenticate and sync, making self-hosted instances first-class without configuration.

### Trusted origin

A server origin the desktop app has explicitly confirmed with the user before loading any of its content — required for every origin other than the default hosted one or a server already linked on the machine. Trust is remembered only from the moment of confirmation, never from an unconfirmed deep link.

## Files & viewing

### Folder default page

The file a folder presents as its front page in the web UI instead of the bare file listing: README.md, index.md, or index.html (case-insensitive, in that precedence). The listing remains reachable via a toggle on the folder page. Relative references inside a default page resolve against the folder it lives in.

### Folder calendar view

A folder presentation that lays its dated child files out on a month calendar, alongside the default page and the file listing. A markdown child appears on the day given by a `date: YYYY-MM-DD` key in its front matter; dragging an entry to another day rewrites that key (a normal version-CAS write). Only dated files appear — undated files stay in the listing. A folder opts in by convention: a `view: calendar` key in its [[Folder default page]] (README/index) front matter makes the calendar its default view, and a `title:` key there gives the folder a human-readable heading (used over the raw folder name in the calendar and listing). These are plain-file conventions, so agents drive them by writing front matter, the same as humans.

## Encryption at rest

### Workspace data key

The encryption key belonging to one Workspace, under which all of that Workspace's file bytes are encrypted before they reach the blob store. It is never stored in the clear: the database holds it only in wrapped form, encrypted under the [[Master key]]. Because it is per-Workspace, a compromise of one Workspace's key exposes no other Workspace — but it draws no distinction between members of the same Workspace, so it adds nothing on top of per-node access control.

### Master key

The single key held in the API's environment secrets that wraps every [[Workspace data key]]. It never touches the blob store or the database. Losing it makes every file in every Workspace permanently unreadable; rotating it re-wraps the Workspace data keys and touches no file bytes at all.

### Crypto-shredding

Destroying a Workspace's stored file contents by destroying its [[Workspace data key]] rather than by deleting bytes. Because file bytes are content-addressed and never garbage-collected, discarding the key is what actually makes them unrecoverable — and it is irreversible, with no grace period.

## Plans & billing

### Plan tier

The named entitlement level an organization sits on — Seedling (free), Grove, or Forest — from which every limit in the product is derived: storage, file count, file size, workspaces, membership, and public share views. The tier attaches to the organization, never to a user or a Workspace, because the organization is the billing entity. Two non-marketed tiers exist alongside them: `legacy` for organizations that predate billing, and `unlimited` for self-hosted deployments.

### Entitlement

The set of limits a Plan tier grants, resolved for an organization. Entitlements resolve from Postgres alone — never from Stripe, never from a cache — so a file write can never block on a payment provider being reachable.

### Grace period

The window after an explicit cancellation or payment failure during which an organization keeps its paid Plan tier's limits, with warnings shown but nothing blocked. Only an explicit, confirmed signal starts it; the absence of billing data never does. When it expires, a Workspace over its new limits becomes read-only rather than losing anything — reads, moves, and deletes stay permitted.

### Share view

One visitor opening a Public link, deduplicated per visitor per link per day — not one HTTP request, so a folder portal that loads twenty images counts once. Views are counted only on the unauthenticated public share surface; a member reading the same file through the app is never a view. Known bots and link unfurlers are excluded.