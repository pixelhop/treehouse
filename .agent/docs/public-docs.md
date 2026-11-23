# Public docs (`trytree.house/docs`)

> **Location:** `packages/marketing/content/docs/` (content) and `packages/marketing/app`
> (rendering). Read this before adding or changing any public docs page.

The public docs are organised around **what the reader is trying to do**, not around our
internal data model. One task lives on exactly one page; every other page links to it.

They have two readers: people, and the agents those people work with. Both read the same
pages. Every page must make sense on its own, fetched as markdown by an agent that has
never seen the rest of the site.

## URL structure

URLs mirror the content tree: `content/docs/<section>/<page>.md` is served at
`/docs/<section>/<page>`. A folder's `index.md` is its **hub page**
(`content/docs/files/index.md` → `/docs/files`). `content/docs/index.md` is the docs
home at `/docs`.

**Moving or renaming a page changes its URL.** Grep both apps and the docs for
hard-coded `/docs/` links, and add a redirect in `nuxt.config.ts` `routeRules` (for the
page and its `.md` twin).

## Sections

| Folder         | Title                 | What belongs there                                                                                 |
| -------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `agents`       | Agents                | The Agents area (below): connecting agents, the agent handbook, the API reference                  |
| `get-started`  | Get started           | What Treehouse is, the quickstart, how it works, letting an agent set up a workspace               |
| `files`        | Files and folders     | Viewing, editing, uploading, organising, folder pages, calendar, history, conflicted copies        |
| `sharing`      | Share and collaborate | Inviting people, share links, comments, activity, customising a workspace                          |
| `desktop`      | Desktop app and sync  | The Mac app, how sync works, managing synced folders, the sync CLI and its reference               |
| `playbooks`    | Playbooks             | Opinionated patterns for running a workspace with agents: AGENTS.md, inboxes, review loops, memory |
| `account`      | Account and billing   | Plans and limits, billing, your account, security and privacy                                      |
| `help`         | Help                  | Troubleshooting, FAQ, glossary                                                                     |
| `self-hosting` | Self-hosting          | Running your own server                                                                            |

`agents/` has three sub-sections, each a folder with its own hub:

| Folder             | Title          | What belongs there                                                         |
| ------------------ | -------------- | -------------------------------------------------------------------------- |
| `agents/connect`   | Connect        | How agents reach a workspace, per-client set-up, API keys                  |
| `agents/handbook`  | Agent handbook | The handbook itself (the folder's `index.md`), plus versions and conflicts |
| `agents/reference` | API reference  | Authentication, MCP tools, REST API, change feed                           |

## Areas

The sections are split into two **areas**, switched with the "Docs | Agents" control at
the top of the sidebar. Each area has its own sidebar, reading order (prev/next never
crosses areas) and breadcrumb root:

- **Docs** (home `/docs`): every section except `agents`. For people using a workspace.
  The playbooks live here because they're written for the person shaping a workspace.
- **Agents** (home `/docs/agents`): everything an agent, or the person connecting one,
  needs. Its sidebar lists the three sub-sections, all expanded. `/docs/agents` is the
  one link to hand an agent.

Areas are defined once in `DOCS_AREAS` (`packages/marketing/app/utils/docs-tree.ts`).

## Frontmatter

Validated by `packages/marketing/content.config.ts` and the docs content tests.

```yaml
---
title: Share a file with a link # H1. Task-phrased for how-tos. Required.
navTitle: Share links # Optional short sidebar label.
seoTitle: Share files with a public link # Optional <title> override (brand suffix is added).
description: Give anyone read-only access to a file or folder, with an optional password. # Required, 50-160 chars. Shown under the H1.
type: how-to # hub | concept | guide | how-to | reference. Required.
position: 3 # Sidebar order, unique within the folder. Required.
updated: 2026-09-29 # Last meaningful content change. Required.
plans: [grove, forest] # Optional. Plans that include the feature.
release: public # public (default) | early-access | unreleased
related: # Optional. Absolute doc paths shown as "Related".
  - /docs/sharing/comments
---
```

The `description` is rendered under the H1 as the page's lede (and at the top of the
markdown twin), so **don't repeat it as the first paragraph**. Start the body with what
comes next.

### Release stages

| Stage          | Built                       | Listed (sidebar, hubs, search, sitemap, llms.txt) | Indexed   | Page shows            |
| -------------- | --------------------------- | ------------------------------------------------- | --------- | --------------------- |
| `public`       | yes                         | yes                                               | yes       | -                     |
| `early-access` | yes, at its final URL       | no                                                | `noindex` | "Early access" banner |
| `unreleased`   | dev and preview builds only | no                                                | no        | "Unreleased" banner   |

Production is the `main` branch build (`WORKERS_CI_BRANCH=main`).

## Page types

- **hub** - folder `index.md`. One or two short paragraphs, then (rendered automatically)
  the list of child pages.
- **concept** - what something is and why it works the way it does. Short. Ends with
  links to the tasks.
- **guide** - an outcome across several features ("Run an inbox your agent files").
  Numbered stages, each linking to the how-to that owns the detail. Playbooks are guides.
- **how-to** - one task:
  1. `::callout` with plan requirement or prerequisites, when relevant.
  2. `## Steps` - numbered, exact UI labels in **bold**, one action per step.
  3. `## Check it worked` (when there's something to check).
  4. `## Troubleshooting` (only real problems, as question-style `###` headings).
- **reference** - settings, tools, endpoints, limits. Tables first, prose second.

## Style

- UK English ("organise", "colour", "behaviour"). The brand is **Treehouse**.
- Voice per `design.md`: warm, plainspoken, quietly confident. Short sentences, concrete
  nouns. No hype ("supercharge", "unlock", "seamless", "the possibilities are endless").
  Agents are **teammates, not tools**: "invite", "connect", never "deploy".
- Second person. Headings in sentence case. Never write `#` in the body (the H1 comes
  from `title`).
- No em dashes in prose; use a comma, colon, full stop or " - ". Exact UI strings that
  contain one (conflicted copy names) are quoted as-is. The content tests enforce this.
- Use the exact UI labels, in **bold**. State limits, plan requirements and what happens
  at the edges.
- Never promise what the product doesn't do. Treehouse stores files; it does not run
  agents or schedules. Say so when it matters.
- Never include real customer names, emails or secrets. Use "Acme", `example.com`,
  `th_example_key`-style placeholders.
- Link generously to the page that owns a task, with absolute paths
  (`/docs/files/version-history`).

## Screenshots

Screenshots live in `packages/marketing/public/docs/images/` as `.webp`, referenced as
`![Descriptive alt text](/docs/images/<name>.webp)`. They are captured from a local stack
with a seeded demo workspace (see `packages/marketing/scripts/docs-screenshots/README.md`). Use
one only where the UI is non-obvious, write alt text that says what the image shows (the
alt is all an agent reading the twin gets), and delete a screenshot rather than keep a
stale one.

## MDC components

- `::callout{type="note|info|tip|warning|agent"}` with optional `title`. `agent` is for
  asides aimed at agents reading the page.
- `::quick-links` wrapping `:::quick-link{title description href icon}` (icon is a
  section folder name, e.g. `agents`).
- Fenced code blocks get a label and copy button; add a filename with
  ` ```json [mcp.json] `.

Components must render sensibly in the markdown twin served to agents: the twin
serialiser (`packages/marketing/server/utils/docs-markdown.ts`) flattens each one to
plain markdown, so a new component needs a case there too.

## Agent surface

- Every page has a markdown twin at `/docs/<path>.md`, advertised with
  `<link rel="alternate" type="text/markdown">`.
- `/llms.txt` is a curated index (connection facts first, then every public page);
  `/llms-docs.txt` is every public page in full.
- The Treehouse agent skill (`packages/marketing/skills/treehouse/SKILL.md`) is published
  at `/.well-known/agent-skills/treehouse/SKILL.md`. Keep it in step with
  `/docs/agents/handbook` - they say the same things.
- `Accept: text/markdown` on a docs page URL returns its twin. Prerendered pages are
  normally served by Workers Static Assets before the Worker runs, so `wrangler.jsonc`
  routes `/docs` through the Worker first (`run_worker_first`) and
  `packages/marketing/server/middleware/docs-assets.ts` answers from the ASSETS binding:
  the `.md` twin for markdown, the prerendered file otherwise (with `Vary: Accept`).

## Checks

`vp test packages/marketing` runs the docs tests in `packages/marketing/test/docs/`:
frontmatter schema, unique positions, internal links and anchors resolve, every folder
has a hub, banned terms and em dashes, images exist, twins free of MDC residue.