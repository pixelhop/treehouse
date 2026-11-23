// The starter kit written into every newly created workspace: one file for the
// human who just arrived at an empty workspace, and one for the agent they point
// at it. Held as string constants rather than read from disk because the API
// ships as a bundle — runtime filesystem reads are not portable across our
// deploy targets.
//
// README.md becomes the workspace's visible front page for free, via the
// folder-default-page convention the app already implements (see
// DEFAULT_PAGE_NAMES in packages/app/app/utils/treehouse.ts).
//
// Both files are written to be REPLACED: the last step of the bootstrap in
// AGENTS.md is for the agent to rewrite them for the workspace that now exists.
// That is what stops generic setup instructions living at the root forever.

export const SEED_README = `---
title: Welcome to your workspace
---

# Welcome to your workspace

This is a Treehouse workspace — a folder of ordinary files that you, your team,
and your AI agents all share. It syncs to a folder on your computer, and
everything in it renders here on the web. There is no special format to learn:
files are just files.

Right now it is empty apart from this note. The quickest way to fill it is to let
an agent do it with you.

## Set it up

If you are reading this in the Treehouse web app, the card just above this note
hands the whole job to Claude Code, Claude Cowork or Codex in one click. Your
agent can get this workspace syncing to your computer too, if it isn't already.
To do it by hand instead:

1. Connect this workspace to a folder on your computer — with the Treehouse
   desktop app, or the \`treehouse\` CLI. (Or connect an agent straight to it over
   MCP, if that is how you work.)
2. Open that folder in your agent — Claude Code, Claude Cowork, Codex, or anything
   else that can work in a folder.
3. Say:

       Read AGENTS.md and set up this workspace.

Your agent will ask what you want this workspace for, suggest a folder structure,
and build it with you once you approve. Then it will suggest what to set up next,
like a weekly sweep of your Inbox.

The instructions it follows are in \`AGENTS.md\`, right next to this file. You can
read them. You can change them.

When setup is finished your agent will replace this note with a real front page
for your workspace — so don't be surprised when it disappears.
`;

export const SEED_AGENTS = `# AGENTS.md

## What this file is

This is a Treehouse workspace: a shared folder of plain files that a person, their
team, and their agents all work in. The Treehouse desktop app or CLI keeps it in
sync with a folder on their computer, and the same files render in the Treehouse
web app, where people read, comment on and share them. There is no special format
to learn: you work here the way you work in any folder.

This particular workspace has not been set up yet — it contains only this file and
a README. **This file is a one-time setup guide.** Follow it when the person asks
you to set up, bootstrap, or organise this workspace.

If you are reading this and the workspace already has a real folder structure with
real content in it, then this file is stale and setup has already happened. Say so
and ask what they actually want, rather than starting over.

The Treehouse docs are at https://trytree.house/docs — add \`.md\` to any page's
address for markdown. If you can read this but can't yet work in the files, see
https://trytree.house/docs/agents/connect/set-up-a-workspace.md to get the
workspace connected first.

## Step 1 — Interview them

Do not create anything yet.

Ask what this workspace is for. Ask conversationally, a few questions at a time —
not as a form. You need to establish:

- **What kind of workspace this is.** A company knowledge base? A personal second
  brain? Client work? A single project?
- **Who will read it.** Just them, a team, or clients and outsiders too.
- **What goes in first.** The thing they already have that needs a home tells you
  more than any abstract answer.
- **Who else will work in it.** Teammates, other agents, scheduled jobs. This
  decides what you suggest at the end.

Keep the interview short. Two or three exchanges are usually enough — they came
here to get going, not to fill in a questionnaire.

Make sure the thing that goes in first has an obvious home in what you propose,
even if the template below doesn't have one. If they start with invoices, there is
somewhere for invoices.

Listen to the words they use for their own work and reuse them. If they call their
customers "members", the folder is Members, not Customers.

**Confirm your understanding before you build anything.** Twenty folders they did
not ask for is a worse outcome than none.

## Step 2 — Propose a structure

Pick the closest template below and adapt it to what they told you. Show them the
tree and get a yes before creating it. Cut folders they have no use for — a
structure with four folders they will fill beats nine that sit empty.

Every template starts with **Inbox/**. See "The Inbox" below — it is the folder
that decides whether the workspace is still alive in six months, so do not drop
it to save space.

Every template also has a **Tasks/** board and a dated folder that opens as a
**calendar** (Meetings/ or Journal/). Keep both, even in a small structure: they
show the person straight away that a folder can be a board or a calendar, and
Step 3 gives each a real first entry. Rename them to fit their words — a studio
might call Tasks "Studio to-dos" — but don't drop them.

### Company knowledge base

For a business capturing what it knows in one place.

    Inbox/          unfiled — dump anything here, sort it later
    Brand/          identity, voice, visual rules
    Product/        what you sell and how it works
    People/         roles, onboarding, ways of working
    Customers/      accounts, feedback, research
    Operations/     process and policy
    Tasks/          board: what's to do, in progress, done
    Meetings/       dated notes, as a calendar

### Personal knowledge base

For one person's second brain.

    Inbox/          unfiled — dump anything here, sort it later
    Notes/          durable notes
    Projects/       things with an end date
    Areas/          ongoing responsibilities
    Resources/      reference material
    Tasks/          board: what's to do, in progress, done
    Journal/        dated entries, as a calendar

### Client work

For an agency or a freelancer.

    Inbox/          unfiled — dump anything here, sort it later
    Clients/        one subfolder per client, each with Brief/, Deliverables/, Notes/
    Brand/          your own identity
    Proposals/
    Templates/      reusable documents
    Tasks/          board: what's to do, in progress, done
    Meetings/       client calls and dated notes, as a calendar

### Project

For a single initiative.

    Inbox/          unfiled — dump anything here, sort it later
    Docs/
    Decisions/      dated decision records
    Research/
    Tasks/          board: what's to do, in progress, done
    Meetings/       dated notes, as a calendar

## Step 3 — Build it

Create the folders, and give **every folder its own README.md** explaining what
belongs in it — a real paragraph, not a placeholder line. The descriptions are what
make the structure usable later, by the next person and by the next agent. An empty
tree teaches nobody anything.

The exception is a repeated shape, like one folder per client with the same
subfolders inside each. Describe the shape once, in the parent's README.md
(Clients/README.md), and give each client folder a short README of its own about
that client. Don't write the same subfolder README thirty times.

For the dated folders — Meetings, Journal, Decisions — put this in the folder's
README.md front matter, with **title set to that folder's own name** (Journal/
gets "Journal", not "Meetings" — the title is what the web app shows as the
heading, so a copied-and-not-edited one mislabels the folder):

    ---
    title: Meetings
    view: calendar
    ---

That makes the folder open as a month calendar in the web app instead of a file
list. Files in those folders should then carry their own date, like this:

    ---
    date: 2026-08-05
    ---

Only files with a valid date appear on the calendar. Changing the date moves the
entry; removing it takes the file off the calendar and leaves it in the listing.

For a folder that tracks work moving through stages — a roadmap, a content
pipeline, a hiring loop, a client's deliverables — offer a **board** instead: one
card per file, one column per stage. Put this in the folder's README.md front
matter, with columns that fit their work in their words, and — as with calendars
— the title set to the folder's own name:

    ---
    title: Roadmap
    view: board
    columns: [Backlog, Doing, Review, Done]
    ---

Each card is a markdown file in that folder whose \`status\` names its column:

    ---
    title: Search filters
    status: Doing
    ---

Tasks/ is always a board, with columns like [To do, Doing, Done] in their words.
Beyond that, only suggest a board where there is real work in flight. It is not a
default for every folder.

### Give the board and the calendar a first entry

An empty board and an empty calendar don't show anyone what they're for. Give
each a few real entries — not lorem ipsum, and not "Example task":

- **Tasks/**: three to five cards drawn from the interview. One card for this
  setup, in the board's done column (whatever they called it). A card for the
  first thing they said they'd put in ("Add the current client briefs"), and one
  for each other concrete next step or deadline you heard, with \`due:\` where
  there's a date. Put their name in \`assignee:\` on the cards that are theirs to
  do.
- **The calendar folder**: one entry dated today, recording this setup — what the
  workspace is for, who it's for, and the decisions you made together. Name it
  like \`2026-08-05-workspace-setup.md\`, with \`title:\` and \`date:\` in its front
  matter. It's the workspace's first meeting note, and a useful record later.

If a shared workspace needs a corner only they can see — personal notes in a team
workspace, say — a folder can be made **private**: visible only to them and their
own agents. They do that in the web app (**Make private** on the folder), or you
can with the \`set_private\` tool if you are connected over MCP. A synced folder
cannot mark anything private on its own.

Tell the person what you created and why, in a couple of sentences, and suggest
they open the workspace in the Treehouse web app to see it — folder front pages,
boards and calendars show there. Then stop and let them look at it.

## The Inbox

Every structure above starts with an **Inbox/**, and it matters more than any of
the other folders.

The reason people abandon a knowledge base is not that it lacks folders. It is
that filing something takes a decision — *which* folder? — at the exact moment
they are busy and just want the thing saved. An Inbox removes that decision.
Anything can be dropped in, unnamed and unsorted, and dealt with later.

That only works if "later" actually arrives. So the Inbox needs two things.

### 1. A filing policy, written down

Give **Inbox/README.md** the rules for where things go once sorted — specific to
this workspace, using the folders you actually created. Something like:

    ---
    title: Inbox
    ---

    Drop anything here — a link, a note, a photo, a half-formed thought. No need
    to name it well or decide where it belongs.

    ## How this gets filed

    - A supplier, price or how-we-do-it note → Operations/
    - Anything about a guest or a booking → Customers/
    - Wording, photos, logo or voice → Brand/
    - Dated and about a conversation → Meetings/, with a date: front-matter key
    - Genuinely unclear → leave it, and ask next time we speak

    Never delete anything from the Inbox, only move it. If you can't tell
    where something goes, leave it here and say so.

    Empty is the goal, not full.

Write the rules from what the person told you in the interview, in their words.
This file is the whole point: without it, every processing run files things
differently and the workspace becomes a second mess.

### 2. Something that actually processes it

**Treehouse does not run agents on a schedule — it is a file store, not a job
runner.** The recurring part has to live wherever the person's agent runs. Say
this plainly rather than implying the workspace will tidy itself. Step 5 covers
offering to set it up.

Two rules for any agent doing the processing, worth writing into the README:
never delete from the Inbox, only move; and when an item's destination is
genuinely unclear, leave it and say so rather than guessing. A filing system
that loses things gets abandoned faster than one that stays messy.

## Step 4 — Finish up

Once the structure exists and they're happy with it, ask whether you should finish
up. If yes:

- **Rewrite README.md** as a genuine front page for the workspace that now exists:
  what it is, what's in it, where things go. Not a welcome note — a front page.
- **Replace this AGENTS.md** with conventions specific to *this* workspace: its
  structure, its naming conventions, its front-matter conventions, how its notes
  link to each other, the tags it uses, and anything they told you in the interview
  that a future agent would need to know. Open it with a line that keeps the next
  agent oriented, like:

      This is a Treehouse workspace: plain files, synced to people's computers
      and shown in the Treehouse web app. How Treehouse works:
      https://trytree.house/docs/agents/handbook.md

- **Create CLAUDE.md** at the root containing just the line \`@AGENTS.md\`, unless
  one already exists. Claude's tools read CLAUDE.md rather than AGENTS.md, and the
  import gives them the same rules instead of a second copy that drifts.

Then tell them, in a couple of sentences, what you changed.

This is the point of the whole exercise. A generic setup guide sitting at the root
forever is clutter; a workspace-specific AGENTS.md is worth more than either file
was on its own.

## Step 5 — Suggest what's next

Finish by offering two or three next steps, chosen from what they told you in the
interview — not this whole list. Offer them; build only the ones they say yes to.
For each yes, add a card to Tasks/ and a line to today's setup note, and if it
is a routine (like the Inbox sweep), add it to AGENTS.md so the next agent knows.

- **Sweep the Inbox on a schedule.** The schedule lives wherever their agent runs:
  scheduled tasks in Claude Code or Claude Cowork, automations in Codex, a cron
  job running an agent non-interactively in the synced folder, or an agent that
  reaches the workspace over MCP. If none of those suits them, a weekly calendar
  reminder to say "process my inbox" is a perfectly good version one. The
  instruction itself stays short, because the rules live in Inbox/README.md:

      Process everything in Inbox/ following the rules in Inbox/README.md.
      File what is clear, leave what is not, and tell me what you moved and what
      you left behind.

- **Invite their team**, if other people will work here. They create an invite
  link from the web app's Dashboard (**Create invite link**); it needs a paid
  plan. https://trytree.house/docs/sharing/invite-people.md
- **Share with people outside the workspace**, if clients or others will read
  some of it. They can give anyone read-only access to a file or folder with a
  public link, from the Share tab in the web app, on every plan. Only a person
  can create one; you can't.
  https://trytree.house/docs/sharing/share-links.md
- **Connect their other agents**, if they use more than one. Each can work in the
  synced folder, or connect over MCP with its own key so its changes are labelled
  as its own. https://trytree.house/docs/agents/connect.md
- **Draft starting notes from their website**, for a company or client work. If
  they want it, read their site and draft only the notes you have real material
  for — positioning, tone of voice, products — with \`status: draft\` and a
  \`sources:\` list of the pages you used in each file's front matter. Never state
  a fact you did not find in a source, and finish by listing the drafts for them
  to check. If you have no web access, say so rather than writing from memory.
- **Add the Treehouse agent skill** to their agent, so later sessions know how
  Treehouse works even outside this folder:
  https://trytree.house/.well-known/agent-skills/treehouse/SKILL.md

Then stop. The workspace is theirs now.

## Treehouse conventions worth knowing

Everything the web app does with these is a plain-file operation — you drive them
by writing files, and there is no special API for any of it.

- A folder's **README.md** (or index.md, or index.html) is shown as that folder's
  front page instead of a bare file listing. The listing stays reachable via a
  toggle.
- **\`title:\`** in a folder's README front matter gives the folder a human-readable
  heading in place of its raw folder name.
- **\`view: calendar\`** in a folder's README front matter makes it open as a month
  calendar, for folders whose files carry dates.
- **\`date: YYYY-MM-DD\`** on a markdown file places it on its folder's calendar.
- **\`view: board\`** in a folder's README front matter makes it open as a board,
  with **\`columns:\`** listing the columns in order. Each markdown file in the
  folder is a card, and its **\`status:\`** names its column — change it to move
  the card. **\`order:\`** (a number) places a card within its column,
  **\`assignee:\`** names who it's for (a member's name from \`list_members\`, or
  anyone else as free text), **\`due:\`** shows a due date, **\`tags:\`** show as
  labels, and \`- [ ]\` task lines in the body show as a checklist count.
  A column can carry a colour (\`- { name: Doing, color: orange }\`), and
  **\`card_fields:\`** picks which other front-matter keys show as chips on
  every card, optionally coloured by value
  (\`- { name: company, colors: { Acme: blue } }\`). Colours: gray, brown,
  orange, yellow, green, blue, purple, pink, red.
- **HTML files** render as pages, so a folder's index.html can be a dashboard or a
  styled front page. They run sandboxed, and scripts only run once a person
  allows them.
- **Private** files and folders are visible only to the person who marked them
  and their own agents.
- **Comments** are review threads people leave on markdown files in the web app.
  They live on the server, not in files, so only the MCP comment tools see them.
- Relative links between files resolve against the folder the file lives in, so
  ordinary markdown links work.
- **Wikilinks** link notes by name: \`[[Launch plan]]\`, \`[[Launch plan|the plan]]\`,
  \`[[Launch plan#Budget]]\`. Capitals don't matter and \`.md\` is optional; add a
  folder (\`[[Clients/Acme/Notes]]\`) when two notes share a name. Prefer them for
  linking notes: they keep working when a note moves to another folder.
- Each file's details list the notes linking to it. Over MCP, \`get_links\` follows
  links both ways and \`move_file\` rewrites the links to a file it renames.
  Renaming a file in a synced folder doesn't: update the links that point at it
  yourself.
- **Tags** group notes across folders: \`tags: [planning, product]\` in front
  matter, or \`#planning\` in the text. Capitals don't matter and \`/\` nests
  (\`#project/alpha\` is under \`#project\`). Typing \`#\` in the sidebar search finds
  them, and \`list_tags\` does the same over MCP. Reuse existing tags rather than
  inventing near-duplicates.
`;