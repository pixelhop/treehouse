---
date: 2026-06-12
topic: activity-feed
focus: activity feed feature for the Treehouse workspace
mode: repo-grounded
---

# Ideation: Treehouse Activity Feed

## Grounding Context

**Codebase Context.** The change-feed _backend already exists_ — the feature gap is
surfacing and consumption, not data capture.

- `ChangeEvent` (Postgres, `packages/db/prisma/schema.prisma`): append-only log with
  `op` (write | move | delete | conflict | restore), `version`, `principal` (agent | human),
  `actorId` / `actorKeyId` / `actorLabel`, `contentHash`, `seq` (monotonic cursor), `createdAt`.
  Attribution is by the API key's `actorType` (by credential, not by route) — so agent-vs-human
  is reliable.
- Changes API `/api/workspaces/[workspaceId]/changes.get.ts`: dual-cursor (`?sinceSeq` ascending
  for sync, `?since` ISO legacy + `?order=desc`), returns `{ changes, head }`, `limit` 0–1000
  (default 200). **No server-side path/principal filtering yet** (flagged as a follow-up in
  `utils/activity.ts`).
- `useChangeFeedPoll.ts`: polls every 5s **only while editing a file**. `utils/activity.ts`:
  client helpers (per-file filter, relative time, restorable check, conflicted-copy finder).
- **UI today:** activity appears ONLY in the per-file right-sidebar "History" tab
  (`FileInfoPanel.vue`). There is **no workspace-wide feed**; agent work is invisible unless you
  open the specific file. No live push. No server-side filtering.
- The single write path (`packages/api/server/utils/files.ts`) feeds all changes to `ChangeEvent`.
- **Strategy:** agents are first-class; key metrics — "agent writes per active workspace/week"
  and "% multi-principal workspaces" — are computed FROM this activity data. Not doing CRDT
  co-editing or branching. Substrate is plain files.
- **Deploy boundary:** Nuxt SPA (`ssr:false`) on Cloudflare Workers; Nitro API on Railway
  (long-lived processes OK there, so SSE/WS would live on Railway). Cross-origin credentialed
  cookies are fragile — any realtime upgrade must survive that.

## Topic Axes

1. Feed surface & presentation
2. Actor attribution & agent-vs-human semantics
3. Delivery & freshness (polling vs realtime, presence)
4. Attention routing (watch/subscribe, @mentions, digests, unread)
5. Agent-native consumption (feed as programmatic input for agents)

## Discussion Outcome (2026-06-12)

The feed is **human-first**: its job is a "what changed while you were away" overview. That
reorders the survivors into a lean v1 plus a parked roadmap.

**v1 — surfacing data already captured:**

- Workspace-wide "while you were away" feed with **read-time clustering** (group consecutive
  same-actor events in a time window). No schema or CLI change. (Idea 1)
- **Unread watermark**: one `lastSeenSeq` int per user/workspace; feed defaults to "new since
  you were here" with a divider + count. (Idea 4)
- **Attribution as-is**: use existing `principal` + `actorLabel`. No author/committer split.
  CLI sync shows as the human owner — accepted.

**Parked for the future (explicitly not v1):**

- Device-name provenance via per-device keys ("Joseph · MacBook Air" as `actorLabel`, set at
  CLI/desktop setup). Someday-note, not now.
- CLI sync-batch IDs — only if read-time clustering looks messy in practice. (No universal "run
  ID": the CLI sees a _sync flush_, not a semantic agent task; MCP could pass a real correlation
  ID; the web editor sees individual edits.)
- Agent consumption of the feed over MCP. (Idea 5)
- SSE live push — polling is acceptable for now. (Idea 3)
- Server-side filtering / standing queries — add when a view needs it. (Idea 6)
- Digests/email, time-travel scrubber.

**Metric consequence consciously accepted:** because folder-synced agent output counts as the
human, "agent writes/week" and "% multi-principal" capture only **Treehouse-native agents**
(those writing directly via MCP/API), not agents whose work arrives via a device sync.

## Ranked Ideas

### 1. Workspace timeline with run-aware coalescing

**Description:** A first-class workspace-wide feed (not the per-file `FileInfoPanel` silo) where a
contiguous same-actor burst collapses into one expandable row ("claude-bot wrote 14 files · 2m
ago"). The "while you were away" handoff brief, keyed to the unread watermark (#4), is the hero
interaction. **v1 uses read-time clustering** (actor + time window); write-time batch IDs are
parked.
**Axis:** 1 — Feed surface & presentation
**Basis:** `direct:` — no workspace-wide feed exists today; CLI sync + MCP fan one logical action
into dozens of `ChangeEvent` rows, so a raw stream gets _less_ readable exactly as agents get
_more_ productive. Clustering key (`actorKeyId` + tight `createdAt` window) is already present.
**Rationale:** This is the front door that makes agent (and other humans') work visible at all,
and the substrate the strategy metrics are read from.
**Downsides:** clustering rules are fuzzy (when does a burst end?); risk of hiding a meaningful
single edit inside an agent run.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Explored

### 2. Two-leg attribution: content-author vs committing-actor

**Description:** Borrow git's author/committer split so a CLI-synced human edit doesn't record as
an agent write. **Superseded in discussion** by the simpler "CLI sync = human owner + device-name
provenance via `actorLabel`" approach; provenance, not authorship, is what's actually wanted.
**Axis:** 2 — Actor attribution & agent-vs-human semantics
**Basis:** `external:` + `direct:` — git author-vs-committer is the canonical fix; the
misattribution risk is real given the CLI sync path and metric dependence. But the device-label
reframe achieves the goal far more cheaply using the existing `actorLabel`.
**Rationale:** Honest agent-vs-human signal underpins the product's headline metrics.
**Downsides:** full two-leg split requires CLI/MCP to pass an origin signal — a contract change.
**Confidence:** 70%
**Complexity:** Med-High (downgraded to Low via the device-label reframe, parked)
**Status:** Explored (reframed → parked)

### 3. SSE live push + presence-as-recency

**Description:** Replace edit-only 5s polling with a Railway-hosted SSE stream keyed on `seq`
(poll stays the fallback, same cursor contract); presence ("an agent is active in /docs now")
falls out of recent-event recency.
**Axis:** 3 — Delivery & freshness
**Basis:** `direct:` — `useChangeFeedPoll` runs only while editing one file, so an idle viewer
sees nothing; `seq`/`head` is a clean reconnect token; SSE belongs on Railway per the deploy
boundary.
**Rationale:** Freshness is the difference between a feed and a log when watching for an agent to
finish.
**Downsides:** must survive cross-origin credentialed cookies (Cloudflare↔Railway), flagged
fragile; polling may be fine for a while.
**Confidence:** 65%
**Complexity:** Med-High
**Status:** Parked

### 4. Watch + unread via per-user `seq` watermark

**Description:** Cheapest unread primitive — store one `lastSeenSeq` int per user/workspace;
everything past it is unread, `head - lastSeenSeq` is the count, and it draws the "new since you
were here" line. Extensible to watching a path (auto-watched from what you touch, or a plain
`.treehouse/watch` file).
**Axis:** 4 — Attention routing
**Basis:** `direct:` — exploits the existing monotonic `seq` cursor; no per-item read model
needed.
**Rationale:** Turns the raw timeline into a personal "what's new for me" view at near-zero cost.
**Downsides:** auto-watch heuristics can over/under-subscribe; digests imply outbound email infra.
**Confidence:** 85%
**Complexity:** Low-Med
**Status:** Explored (in v1)

### 5. Feed-as-MCP-resource: agent situational awareness

**Description:** Expose the feed to agents via MCP / `?sinceSeq` as `recent_changes(sinceSeq,
filter)` so an agent starting work asks "what changed here, by whom, since I last ran?" instead of
re-scanning the tree — and avoids clobbering a file a human just touched. Makes the feed a
coordination primitive, not just human chrome.
**Axis:** 5 — Agent-native consumption
**Basis:** `direct:` — MCP server (`/api/mcp`) + ascending `sinceSeq` cursor already exist; purest
expression of the agent-native strategy; directly feeds the agent-writes metric.
**Rationale:** Highest strategic-differentiation direction; an agent that reads recent activity
collaborates instead of colliding.
**Downsides:** needs loop-prevention (agent ignores its own `actorKeyId`); shapes a new public
contract. Demoted to fast-follow because the feed is human-first.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Parked (fast-follow)

### 6. Server-side filtered read model / standing queries

**Description:** Add `?path=` / `?principal=` / `?op=` filtering server-side (none today) and let a
saved filter be both a live view and a subscription target — the join point that turns #2/#4/#5
into parameterizations of one read model.
**Axis:** spine (cross-axis)
**Basis:** `direct:` — `changes.get.ts` is dual-cursor only; `utils/activity.ts` filters
client-side and flags server-side filtering as the follow-up "if the feed grows large."
**Rationale:** Concentrates leverage — build once, many surfaces inherit it.
**Downsides:** low standalone excitement; value realized only through the surfaces above.
**Confidence:** 90%
**Complexity:** Low-Med
**Status:** Parked (add when a v1 view needs it)

## Rejection Summary

| #   | Idea                                            | Reason Rejected / Folded                                                       |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Handoff brief / standup / prose digest          | Folded as the hero UX of #1 + #4, not a separate idea                          |
| 2   | Time-travel scrubber / black-box reconstruction | Strong, but that's _version history_ — a separate feature from "activity feed" |
| 3   | Activity overlay on the file tree               | Alternative presentation of #1; brainstorm variant                             |
| 4   | Mandatory acknowledgment ledger                 | Over-engineered; #4 watermark covers the human-readable case                   |
| 5   | Local-first `treehouse log` CLI feed            | Nice DX, but secondary to web/agent surfaces; brainstorm variant               |
| 6   | Wire-priority codes / SBAR / ATC strips         | Analogies feeding #1/#3 presentation, not standalone ideas                     |
| 7   | Semantic diff enrichment (+40/-3)               | Useful enhancer of #1; fold in, not standalone                                 |
| 8   | Coordination bus (intent before write)          | Speculative; depends on presence (#3) landing first                            |
| 9   | Subscriptions as plain files (.treehouse/watch) | Implementation variant of #4                                                   |