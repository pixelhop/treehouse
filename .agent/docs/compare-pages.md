# Comparison pages and guides

> **Location:** `packages/marketing/content/pages/` (content) and
> `packages/marketing/app/components/landing/` (rendering). Read this before adding a page or
> changing what one claims.

These pages are for people who aren't on Treehouse yet. Their job is signups, and they get
those by being the most honest page a reader can find. A comparison that admits its gaps is
more credible, and it's cited more often in AI answers.

`content/pages/compare/<slug>.md` is served at `/compare/<slug>`, and
`content/pages/guides/<slug>.md` at `/guides/<slug>`. The `/compare` hub lists everything in
the collection, including guides. `/guides` redirects there until there are enough guides to
need a hub of their own.

## What to lead with

Two things, as one pitch: **agents get the speed of local files, and the team stays in step.**
A folder on one laptop is fast but stops at one person; a hosted workspace is shared but every
read is a network request. Lead with this where it's true, which is Notion above all.

Be exact about it. The speed comes from the synced folder, not MCP. Obsidian is already local,
so there the gain is sharing, not speed. Fastio can also keep files local, so don't claim a
speed win over it.

The speed table on the Notion page is measured on our side (`cat` and `grep` over generated 6 KB
Markdown notes) and calculated on theirs (one request a page at published limits). Keep that
labelling, and re-check the limits when you update `lastChecked`.

## Why guides aren't in the docs

The docs are for people working in a workspace: one task to a page, in reading order. A guide
here is for someone deciding whether to start, so it needs to sell, and it needs the
marketing chrome and signup calls to action. It shares the comparison template, so a separate
path costs nothing. Link to the docs for detail rather than repeating them.

## Adding or updating a page

1. Verify every claim about the other product on its own current site or docs. Open the page:
   search snippets aren't sources. Say "their docs describe no..." rather than "they can't".
2. Set `lastChecked` to that date, and list each page in `sources`.
3. Check the page's `/compare` card, `llms.txt` entry and `.md` twin. All three are generated.
4. Add a new page's path to the list in `test/compare/content.test.ts`.

The frontmatter is the contract: `content.config.ts` defines it, and `LandingArticle.vue` gives
every page the same order (short answer, table, long version, questions, sources, date).
`vp test packages/marketing` enforces the rest: description length, dated sources, a "better
choice" section on every comparison, working links, and the banned claims below.

Treehouse's own prices are written into these pages by hand, so **update them when the Stripe
prices change**. Everywhere else reads them live from `/api/plans`.

## Rules on claims

- **No open source or self-hosting claims** until the repo is public. The AGPL licence is on
  `main`, but readers can't see the code yet. `layouts/default.vue`, `utils/siteNav.ts` and
  `SiteGithubLink.vue` drop the site's own open-source links on these pages, so remove those
  filters at the same time.
- **Don't market search or per-tier history retention.** The owner has held them back.
- **Encryption is protection at rest.** Never zero-knowledge.
- **Only claim what's merged and live on `main`.** Check `gh pr view` rather than the plan.
- **Never promise a trash retention period.** It's still being confirmed.
- **No competitor logos.** Check the brand's terms first.

When a feature ships, remove it from `BANNED_TREEHOUSE_CLAIMS` in the test and add it to the
pages. Waiting at the time of writing: the Viewer role, scoped keys and folder grants. In the other
direction, re-check the Obsidian page's test table and "What doesn't work yet" in the guide
whenever linking or sync changes. Those say what's true today, and they went stale once
already when wikilinks shipped mid-draft.

## Measuring signups

Every signup link carries UTM tags (`app/utils/landing.ts`):

| Tag            | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| `utm_source`   | `trytree.house`                                                    |
| `utm_medium`   | `compare` or `guide`                                               |
| `utm_campaign` | The page: `compare-obsidian`, `guide-obsidian-and-claude-code-...` |
| `utm_content`  | Where on the page: `hero`, `end`, `nav` or `twin`                  |

The app's PostHog strips query strings from URLs but keeps these as event properties. To
count signups by page, take `$identify` events with `utm_campaign` set, broken down by
`utm_campaign`. Treat it as a close estimate, not a ledger:

- Don't filter on `$pathname`. Email signups identify on `/sign-up`, Google and GitHub signups
  on `/plans`, and email confirmation moves that again.
- It also counts a returning person who followed a tagged link and then signed in. These links
  go to the sign-up page, so that should be rare.
- It misses anyone who confirms their email on a different device, because that session has no
  tags.

Use the event's `utm_campaign` rather than the person's `$initial_utm_campaign`: someone who
accepted analytics on the marketing site already has a first touch, so that one can be empty.

Clicks are autocaptured for visitors who accepted analytics, labelled by
`data-ph-capture-attribute-cta`. Headless browsers are dropped as bots, so test with a real
browser or switch off `opt_out_useragent_filter`.

Don't rename a tag: it splits the history in two.