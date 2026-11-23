// Fictional content for the docs screenshot workspace (see seed.mjs). A small
// design studio, "Acme Studio", with two clients and a website relaunch in
// flight. Dates cluster around late September 2026 so the calendar views have
// something to show.

export const ROOT_README = `---
title: Acme Studio
---

Everything the studio knows, in one place: our clients, the work in flight, the
decisions behind it, and how we sound. Shared by the four of us and the agents
we work with.

## Where things live

| Folder | What's in it |
| --- | --- |
| [Inbox](Inbox/README.md) | Anything unsorted. Filed every morning. |
| [Clients](Clients/README.md) | One folder per client: brief, notes and deliverables. |
| [Projects](Projects/README.md) | Our own work in flight. |
| [Decisions](Decisions/README.md) | Why things are the way they are. |
| [Meetings](Meetings/README.md) | Notes from every meeting. |
| [Brand](Brand/README.md) | How we look and sound. |
| [Templates](Templates/README.md) | Starting points for recurring documents. |

## This week

- Website relaunch: the launch announcement is in review.
- Northwind: October report is shared with the client.
- Bluebird Bakery: proposal due Friday.
`;

export const ROOT_AGENTS = `# AGENTS.md

Acme Studio's workspace: client work, our own projects, decisions and meeting
notes for a four-person design studio and the agents we work with.

## Where things go

- Inbox/ - anything unsorted. Filing rules are in Inbox/README.md.
- Clients/<name>/ - Brief/, Notes/ and Deliverables/. Deliverables/ is shared
  with the client: finished work only, nothing internal.
- Projects/<name>/ - README.md is the status page. Update it when you finish.
- Decisions/ - one file per decision, YYYY-MM-DD-short-title.md, from
  Templates/decision.md.
- Meetings/ - dated notes. Opens as a calendar.
- Archive/ - anything retired. Move things here instead of deleting them.

## Conventions

- Front matter on drafts: status: draft | review | final. Only a person sets
  final.
- Dates are always YYYY-MM-DD.
- Link to files rather than copying them.

## Working rules for agents

- Never delete files. Move them to Archive/ and say so.
- Don't create top-level folders. Propose them.
- Address open review comments before anything else on a file in review.
- End every task with a list of what you created, changed or moved.
`;

const folderReadme = (title, body, extra = "") => `---\ntitle: ${title}${extra}\n---\n\n${body}\n`;

export const AGENT_FILES = {
  "Inbox/README.md": `---
title: Inbox
---

Drop anything here: a link, a note, a screenshot, a half-formed thought. No need
to name it well or decide where it belongs.

## How this gets filed

- About a client → Clients/<client>/Notes/
- A decision we've made → Decisions/, from Templates/decision.md
- Notes from a conversation → Meetings/, with a date: in the front matter
- Wording, logos or voice → Brand/
- Genuinely unclear → leave it here and list it in the summary

## Rules for whoever files

- Never delete anything from the Inbox. Only move.
- When in doubt, leave it.

Empty is the goal, not full.
`,
  "Clients/README.md": folderReadme(
    "Clients",
    "One folder per client. Each has Brief/ (what they asked for), Notes/ (internal) and Deliverables/ (shared with the client).",
  ),
  "Clients/Northwind/README.md": `---
title: Northwind
status: active
owner: Sam
---

Northwind Outdoor, a kit retailer relaunching their loyalty programme. Monthly
retainer for campaign design and reporting.

- **Contact:** Jordan Lee, Head of Marketing
- **Current:** October campaign report (shared)
- **Next:** November campaign concepts, due 14 October

See the [brief](Brief/brief.md) and the latest [deliverables](Deliverables/README.md).
`,
  "Clients/Northwind/Brief/brief.md": `---
title: Northwind retainer brief
---

## What they want

A monthly campaign for the Trailhead loyalty programme, with a short report on
how the last one performed.

## Constraints

- Brand guidelines from Northwind's own site, not ours.
- Reports go to their board, so keep them to one page.
`,
  "Clients/Northwind/Notes/2026-09-24-kickoff.md": `---
title: October kickoff call
date: 2026-09-24
---

- Jordan wants the report to lead with sign-ups, not impressions.
- New Trailhead tier launches 20 October.
`,
  "Clients/Northwind/Deliverables/README.md": `---
title: Northwind deliverables
---

Finished work for Northwind. This folder is shared with the client.

- [October campaign report](october-report.html)
- [Trailhead brand sheet](trailhead-brand-sheet.md)
`,
  "Clients/Northwind/Deliverables/trailhead-brand-sheet.md": `---
title: Trailhead brand sheet
---

## Colours

Pine (#2F5D46), Granite (#4A4F55), Sunrise (#F2A65A).

## Voice

Plain, outdoorsy, never jokey about safety.
`,
  "Clients/Northwind/Deliverables/october-report.html": `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Northwind · October campaign report</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f6f4ee; color: #2b2f33; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 32px; }
  h1 { font-size: 30px; margin: 0 0 4px; }
  .sub { color: #6b6f68; margin: 0 0 32px; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px; }
  .stat { background: #fff; border: 1px solid #e5e0d2; border-radius: 14px; padding: 18px; }
  .stat b { display: block; font-size: 28px; color: #2f5d46; }
  .bar { height: 10px; border-radius: 99px; background: #e5e0d2; margin: 6px 0 16px; }
  .bar span { display: block; height: 100%; border-radius: 99px; background: #2f5d46; }
</style>
</head>
<body>
<main>
  <h1>October campaign report</h1>
  <p class="sub">Trailhead loyalty programme · prepared by Acme Studio</p>
  <div class="stats">
    <div class="stat"><b>1,284</b>new members</div>
    <div class="stat"><b>18.2%</b>email open-to-join</div>
    <div class="stat"><b>£41k</b>member revenue</div>
  </div>
  <h2>Sign-ups by channel</h2>
  <p>Email</p><div class="bar"><span style="width:62%"></span></div>
  <p>In store</p><div class="bar"><span style="width:27%"></span></div>
  <p>Social</p><div class="bar"><span style="width:11%"></span></div>
</main>
</body>
</html>
`,
  "Clients/Bluebird Bakery/README.md": `---
title: Bluebird Bakery
status: proposal
owner: Priya
---

Independent bakery chain, three shops. Wants a new identity and a simple
ordering site. Proposal due Friday.
`,
  "Projects/README.md": folderReadme(
    "Projects",
    "Our own work in flight. Each project's README.md is its status page.",
  ),
  "Projects/Website relaunch/README.md": `---
title: Website relaunch
status: in-progress
owner: Sam
---

## Where we are

Homepage and pricing copy are final. The launch announcement is in review.

## Next

- Final pass on the announcement (agent)
- Book the launch newsletter slot (Sam)

## Log

- 2026-09-26: Pricing copy signed off.
`,
  "Projects/Website relaunch/Tasks/README.md": `---
title: Relaunch tasks
view: board
columns: [Backlog, Doing, Review, Done]
---

One card per task. Move a card by changing its \`status\`.
`,
  "Projects/Website relaunch/Tasks/launch-announcement.md": `---
title: Launch announcement
status: Review
order: 1
due: 2026-10-02
assignee: [Sam, claude]
tags: [copy]
---

Final pass on the announcement before it goes out.

- [x] First draft
- [x] Studio price checked with Priya
- [ ] Sam's sign-off
`,
  "Projects/Website relaunch/Tasks/pricing-page.md": `---
title: Pricing page
status: Done
tags: [copy, web]
assignee: Priya
---

Copy signed off on 26 September.
`,
  "Projects/Website relaunch/Tasks/homepage-hero.md": `---
title: Homepage hero illustration
status: Done
tags: [design]
assignee: Sam
---

Final artwork exported at 2x.
`,
  "Projects/Website relaunch/Tasks/newsletter-slot.md": `---
title: Book the launch newsletter slot
status: Doing
order: 1
due: 2026-10-01
assignee: Sam
---

- [x] Ask for October dates
- [ ] Confirm the 6 October slot
`,
  "Projects/Website relaunch/Tasks/redirects.md": `---
title: Redirects from the old site
status: Doing
order: 2
tags: [web]
assignee: claude
---

- [x] Export old URLs
- [x] Map to new pages
- [ ] Test on staging
- [ ] Ship with the launch
`,
  "Projects/Website relaunch/Tasks/case-studies.md": `---
title: Two new case studies
status: Backlog
tags: [copy]
---

Northwind and one more. Needs client sign-off first.
`,
  "Projects/Website relaunch/Tasks/analytics.md": `---
title: Privacy-friendly analytics
status: Backlog
due: 2026-10-10
tags: [web]
---

Pick a tool and add it before launch.
`,
  "Projects/Website relaunch/Tasks/og-images.md": `---
title: Social preview images
status: Blocked
assignee: Priya
tags: [design]
---

Waiting on the final headline.
`,
  "Projects/Website relaunch/Tasks/team-photos.md": `---
title: Team photos for the about page
---

Idea from Tuesday: shoot in the studio, natural light.
`,
  "Projects/Social videos/README.md": `---
title: Social videos
view: board
columns:
  - Ideas
  - name: Scripting
    color: yellow
  - name: Filming
    color: orange
  - name: Editing
    color: purple
  - name: Published
    color: green
card_fields:
  - name: company
    colors:
      Northwind: blue
      Bluebird Bakery: pink
      Acme Studio: green
  - platform
---

Short videos for us and our clients, one card each.
`,
  "Projects/Social videos/northwind-report-recap.md": `---
title: October report in 60 seconds
status: Scripting
company: Northwind
platform: [TikTok, Reels]
due: 2026-10-08
assignee: Priya
---
`,
  "Projects/Social videos/bakery-behind-the-scenes.md": `---
title: 4am at the bakery
status: Filming
company: Bluebird Bakery
platform: Reels
due: 2026-10-03
assignee: Sam
---
`,
  "Projects/Social videos/bakery-new-loaf.md": `---
title: The new sourdough
status: Ideas
company: Bluebird Bakery
platform: TikTok
---
`,
  "Projects/Social videos/studio-relaunch-teaser.md": `---
title: Relaunch teaser
status: Editing
company: Acme Studio
platform: [YouTube Shorts, Reels]
due: 2026-10-05
assignee: [Sam, claude]
---
`,
  "Projects/Social videos/studio-pricing-explainer.md": `---
title: Studio tier, explained
status: Ideas
company: Acme Studio
platform: YouTube Shorts
---
`,
  "Projects/Social videos/northwind-team-intro.md": `---
title: Meet the Northwind team
status: Published
company: Northwind
platform: Reels
---
`,
  "Projects/Social videos/studio-process.md": `---
title: How we run a review round
status: Scripting
company: Acme Studio
platform: TikTok
assignee: claude
---
`,
  "Decisions/README.md": folderReadme(
    "Decisions",
    "One file per decision, so we (and our agents) can find out why things are the way they are. Never edited after the fact: a reversal is a new decision.",
    "\nview: calendar",
  ),
  "Decisions/2026-09-12-studio-pricing.md": `---
title: Studio tier is £59 a month
date: 2026-09-12
status: decided
---

## Decision

The Studio tier moves from £49 to £59 a month from the relaunch.

## Why

It now includes two review rounds instead of one.
`,
  "Decisions/2026-09-26-pricing-copy.md": `---
title: Pricing page copy signed off
date: 2026-09-26
status: decided
---

## Decision

Ship the pricing page copy as drafted, with the FAQ moved below the plans.
`,
  "Meetings/README.md": folderReadme(
    "Meetings",
    "Notes from every meeting, one file each, dated.",
    "\nview: calendar",
  ),
  "Meetings/2026-09-03-weekly-studio.md": `---\ntitle: Weekly studio\ndate: 2026-09-03\n---\n\n- Relaunch scope agreed.\n`,
  "Meetings/2026-09-10-weekly-studio.md": `---\ntitle: Weekly studio\ndate: 2026-09-10\n---\n\n- Pricing options reviewed.\n`,
  "Meetings/2026-09-15-northwind-review.md": `---\ntitle: Northwind review\ndate: 2026-09-15\n---\n\n- September report well received.\n`,
  "Meetings/2026-09-17-weekly-studio.md": `---\ntitle: Weekly studio\ndate: 2026-09-17\n---\n\n- Launch date set for 6 October.\n`,
  "Meetings/2026-09-22-bluebird-intro.md": `---\ntitle: Bluebird intro call\ndate: 2026-09-22\n---\n\n- Three shops, ordering site, new identity.\n`,
  "Meetings/2026-09-24-weekly-studio.md": `---\ntitle: Weekly studio\ndate: 2026-09-24\n---\n\n- Announcement draft assigned.\n`,
  "Brand/README.md": folderReadme("Brand", "How Acme Studio looks and sounds."),
  "Brand/tone-of-voice.md": `---
title: Tone of voice
---

We write like a good studio partner: clear, warm and specific.

- Short sentences.
- Say what changed for the reader.
`,
  "Templates/README.md": folderReadme("Templates", "Starting points for recurring documents."),
  "Templates/decision.md": `---
title: Short title of the decision
date: YYYY-MM-DD
status: decided
---

## Decision

## Why

## Consequences
`,
  "Archive/README.md": folderReadme(
    "Archive",
    "Retired files. Moved here instead of being deleted.",
  ),
};

export const SAM_FILES = {
  "Inbox/call-with-bluebird.md":
    "Bluebird want to see two identity routes, not three. Budget confirmed.\n",
  "Inbox/northwind-feedback.md":
    "Jordan: loved the October report, can we add in-store sign-ups next month?\n",
  "Inbox/podcast idea.md":
    "Maybe a short podcast about how small studios use agents? Not sure where this goes.\n",
  "Sam's drafts/relaunch-thank-yous.md": "People to thank when the site goes live.\n",
};

export const INBOX_MOVES = [
  ["Inbox/call-with-bluebird.md", "Clients/Bluebird Bakery/Notes/2026-09-29-call.md"],
  ["Inbox/northwind-feedback.md", "Clients/Northwind/Notes/2026-09-29-feedback.md"],
];

export const ANNOUNCEMENT_V1 = `---
title: Launch announcement
status: draft
---

We're thrilled to announce our brand new website!

Booking a project with Acme Studio is now easier than ever. Pick a package,
choose a start date and you're done.

Pricing starts at £49 a month.
`;

export const ANNOUNCEMENT_V2 = `---
title: Launch announcement
status: review
---

We're thrilled to announce our brand new website!

Booking a project with Acme Studio is now easier than ever. Pick a package,
choose a start date and you're done. Every project now includes two rounds of
review.

Pricing starts at £49 a month.
`;

export const ANNOUNCEMENT_V3 = `---
title: Launch announcement
status: review
---

You can now book a project with us in three clicks.

Pick a package, choose a start date and you're done. Every project now includes
two rounds of review, so there's room to get it right.

Pricing starts at £49 a month.
`;

export const PRIYA_MEETING = `---
title: Weekly studio
date: 2026-09-29
---

- Announcement nearly ready, pricing line to fix.
- Bluebird proposal on track for Friday.
`;

export const STATUS_SAM = `---
title: Website relaunch
status: in-progress
owner: Sam
---

## Where we are

Homepage and pricing copy are final. The launch announcement is in review;
Priya is checking the pricing line.

## Next

- Final pass on the announcement (agent)
- Book the launch newsletter slot (Sam, done)

## Log

- 2026-09-29: Newsletter slot booked for 6 October.
- 2026-09-26: Pricing copy signed off.
`;

export const STATUS_AGENT = `---
title: Website relaunch
status: in-progress
owner: Sam
---

## Where we are

Homepage and pricing copy are final. The launch announcement has been revised
after review; one comment is waiting on Priya.

## Next

- Final pass on the announcement (agent)
- Book the launch newsletter slot (Sam)

## Log

- 2026-09-29: Revised the announcement opening after Sam's comments.
- 2026-09-26: Pricing copy signed off.
`;

export const TONE_V2 = `---
title: Tone of voice
---

We write like a good studio partner: clear, warm and specific.

- Short sentences.
- Say what changed for the reader.
- No "thrilled", "excited" or "game-changing".
`;

export const TONE_V3 = `---
title: Tone of voice
---

We write like a good studio partner: clear, warm and specific.

- Short sentences. One idea each.
- Say what changed for the reader, in their terms.
- No "thrilled", "excited" or "game-changing".
- Numbers beat adjectives: "in three clicks", not "effortlessly".
`;