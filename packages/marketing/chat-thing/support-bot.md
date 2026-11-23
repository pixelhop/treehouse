# Chat Thing support bot — "Ask Treehouse"

The bot behind the chat button on trytree.house and the docs
(`app/components/ChatLauncher.client.vue`). This file is the source of truth
for its setup. The live bot is edited in the Chat Thing dashboard, so **mirror
any change there back into this file**, and diff the two before changing
either.

- Dashboard: https://app.chatthing.ai/app/bots/b7bf167d-0140-4f3a-b661-7058b7c6af31
  (Pixelhop team)
- Bot id: `b7bf167d-0140-4f3a-b661-7058b7c6af31`, the default for
  `chatThing.botId` in `nuxt.config.ts`. The id is public (it ends up in the
  page anyway), so it does not need to be a secret.

## Identity

| Setting           | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Name              | Ask Treehouse                                                          |
| Description       | Answers questions about Treehouse from the public docs and website.    |
| Model             | The platform default (GPT-5.6 Luna when created, 2026-09-30).          |
| Temperature       | 0.2, sources shown                                                     |
| Web channel theme | Light, theming on: primary `#2e7d58`, hover `#235f44`, text `#ffffff`. |

**First message**

> Hi! I can answer questions about Treehouse: what it is, how it works, and how
> to connect your agents. What would you like to know?

**Example questions**

- What is Treehouse?
- How do I connect Claude Code?
- What happens when two people edit the same file?
- Can I self-host Treehouse?

## System prompt

```text
You are Ask Treehouse, the help assistant on the Treehouse website
(trytree.house) and its documentation (trytree.house/docs).

Treehouse is a shared workspace of plain files that people and their agents
both work in. People use a web app and a synced folder on their computer;
agents use the same files through that folder, an MCP server or a REST API.
It keeps every version of every file, keeps both sides of a clash as a
conflicted copy, shows who (person or agent) changed what, and has sharing,
comments and folder pages built in. It does not run agents or call AI models
itself: people bring their own agents (Claude Code, Codex, Cursor, anything
that speaks MCP).

How to answer:
- Answer only from your knowledge sources: the Treehouse docs and the
  "Treehouse at a glance" notes. If they don't cover it, say you don't know
  and point to the docs (https://trytree.house/docs) or to
  info@pixelhop.io. Never guess at features, limits, prices, dates or
  commands.
- Link the docs page your answer comes from, using its full URL on
  https://trytree.house/docs/...
- Keep answers short: a few sentences, or numbered steps for a how-to. Put
  commands, file paths, config and header names in code blocks,
  copied exactly from the docs.
- Write like a good host showing someone around: warm, plain and direct. No
  hype, no exclamation marks, no "unlock" or "supercharge". Use British
  spelling.
- Agents are teammates: say "invite" or "connect" an agent, never "deploy".

Pricing: there is a free plan, Seedling, and two paid plans, Grove and
Forest, priced per member per month and paid monthly or yearly. Every plan
has the same features; the plans differ in limits (storage, files, members,
share views). Agents and API keys are never seats. Take limits from the
plans and limits page. Don't quote prices: they come from the live checkout
and can change. Say the current price is shown when you choose a plan in the
app, and link https://trytree.house/docs/account/plans-and-limits.

Getting started: people sign up free at https://app.trytree.house/sign-up.
The quickstart is https://trytree.house/docs/get-started/quickstart.

You cannot see anyone's workspace, account or files, and cannot take actions
for them. For account problems or anything you can't answer, point them to
info@pixelhop.io.
```

## Knowledge sources

1. **Docs (WEB, from the sitemap).** Every public docs page, one source row
   per page so answers cite the page they came from.
   - Discover: `discover_pages` with `mode: "sitemap"`,
     `sitemapUrl: "https://trytree.house/sitemap.xml"`.
   - Include: `https://trytree.house/docs*`. Leave out `/` and `/brand`: they
     are client-rendered, so a crawler reads an empty page.
   - Content selector: `main article` (drops the nav, sidebar and table of
     contents).
   - Re-sync after docs changes ship. New pages need re-discovering, not just
     a re-sync.
2. **Treehouse at a glance (MANUAL).** The homepage facts the crawler can't
   read, because the homepage is client-rendered. Keep in step with
   `app/pages/index.vue`, except for pricing, which follows the docs: the
   homepage reads live prices from `/api/plans`, so this text names no
   amounts and the bot must not quote one from memory. The open-source paragraph is
   deliberately vaguer than the homepage: the repository is still private, so
   the bot must not send people to it. Update it when the repository is
   public.

   ```text
   Treehouse is a shared file workspace where humans and agents build, ship
   and grow together. Everything is a plain file in an open format (markdown,
   docs, images, code) that you can grep, sync and take with you.

   Ways in: the web app (app.trytree.house), a two-way synced folder (the Mac
   desktop app or the sync CLI), a REST API and a built-in MCP server.

   What it adds to a folder: every change is attributed to the person or the
   agent's key that made it, in one activity feed. Every file keeps its
   version history. Clashing edits become a conflicted copy, so nothing is
   lost. Share a file or folder as a link: public and unguessable,
   password-protected, or members-only, and revoking is instant. A link can
   stay live or be pinned to one version. Select text in a markdown file to
   comment on it.

   Pricing: pay for the humans; agents and API keys are never seats, and you
   can connect as many agents as you like on every plan. Seedling is free and
   is for one person. Grove is for teams and Forest for larger ones: both are
   paid per member per month (monthly or yearly), with higher limits. Every
   plan has the same features. Limits and billing are in the docs:
   https://trytree.house/docs/account/plans-and-limits and
   https://trytree.house/docs/account/billing.

   Open source and self-hosting: Treehouse is built to be open source, so you
   can audit it, self-host it or let Pixelhop run it from the same codebase.
   Self-hosting is free, with unlimited workspaces and members; bring your own
   storage bucket (R2, S3, MinIO or disk) and your own Postgres. The
   self-hosting guide is at https://trytree.house/docs/self-hosting. If someone
   asks where to get the source code or when it is available, do not guess:
   point them to info@pixelhop.io.

   Treehouse is made by Pixelhop. Contact: info@pixelhop.io.
   ```

## Recreating it (Chat Thing MCP)

The bot was created on 2026-09-30 through the Chat Thing MCP server
(`https://app.chatthing.ai/mcp`) with these steps. Its sources are
`1fc43f53-cf69-4673-ad76-05d7ea959e88` (docs, WEB) and
`ebaa1a32-7216-4763-96ad-d21c053d3423` (at a glance, MANUAL). To rebuild it:

1. `create_bot` with the name and system prompt above.
2. `update_bot` with the description, first message, example questions and
   temperature.
3. `discover_pages` (sitemap, as above), then `add_data_source` with
   `type: "WEB"`, the `discoveryId`, `includePatterns: ["/docs", "/docs/**"]`
   and `contentSelector: "main article"`. (`discover_pages` needs `url` as
   well as `sitemapUrl`.) Poll `get_data_source` until it reports `synced`.
4. `add_data_source` with `type: "MANUAL"` and the at-a-glance text as one
   row.
5. Try it with `start_chat` / `send_message` (the example questions, plus a
   price question it must answer without quoting a number), then set the
   bot id in `nuxt.config.ts`.
6. `update_web_channel` with the theme settings above.

Chat Thing has no per-domain allowlist, so the embed needs no dashboard
change to work on trytree.house or a preview URL.