---
title: Turn a folder into a page or calendar
navTitle: Folder pages and calendars
description: Give a folder a front page with a README, or show a folder of dated notes as a calendar you can reschedule by dragging.
type: how-to
position: 5
updated: 2026-09-30
related:
  - /docs/files/boards
  - /docs/files/front-matter
  - /docs/files/html-pages
  - /docs/playbooks/shape-your-workspace
---

A folder doesn't have to open as a list of files. Put the right file in it and it opens as a page, or as a calendar of what's inside.

## Give a folder a front page

1. Add a file called `README.md` to the folder.
2. Select the folder in the sidebar.

The README now shows when you open the folder. Treehouse looks for these files, in this order, and uses the first it finds:

1. `README.md`
2. `index.md`
3. `index.html`

Case doesn't matter, so `readme.md` works. If a folder has more than one spelling of the same name, the exact spelling above wins, otherwise the first alphabetically. This works for the workspace root too: a `README.md` at the top of the workspace becomes its front page.

When a folder has a front page, the top bar shows a switcher with the page's file name and **Files**, plus **Calendar** if the folder has dated notes and **Board** if its notes have a `status`. Boards have [their own page](/docs/files/boards).

## Edit a folder's front page

The front page is read-only while you're looking at the folder. To change it:

1. Select **⋯** in the top bar, then **Open file**.
2. Select **Edit**.

An `index.html` front page is shown full width, like any [HTML page](/docs/files/html-pages).

## Give a folder a nicer heading

Add a `title` to the front page's front matter. It replaces the folder's name as the heading of the **Files** and **Calendar** views. The breadcrumb still shows the real folder name.

```markdown [content/README.md]
---
title: Social content
---

Posts for the next quarter, one file per post.
```

## Show a folder as a calendar

Any markdown file directly inside the folder with a `date` in its front matter appears on the folder's calendar.

1. Add a `date` in `YYYY-MM-DD` form to each note's front matter.
2. Select the folder, then **Calendar** in the top bar.

```markdown [content/launch-post.md]
---
title: Launch post
date: 2026-10-14
---

Draft of the launch announcement.
```

**Calendar** appears on any folder with dated notes, whether or not it has a front page. Each note is labelled with its `title`, or its file name if it has none. Files without a valid date, files that aren't markdown, and files in subfolders are left off. Select a note to open it.

![A folder of dated posts shown as a month calendar, with posts on their days and the Previous month, Today and Next month controls in the header](/docs/images/folder-calendar.webp)

The calendar opens on the current month. Use **Previous month**, **Today** and **Next month** to move around. A busy day shows three notes and a **+N more** button for the rest. On a phone, the month is shown as a list of the days that have notes.

## Open a folder as a calendar by default

Add `view: calendar` to the folder's `README.md` (or `index.md`) front matter:

```markdown [content/README.md]
---
title: Social content
view: calendar
---
```

The folder then opens on the calendar, as long as at least one note in it has a valid date. The front page is one click away in the switcher.

## Reschedule by dragging

Drag a note to another day. Treehouse rewrites the `date` in that file's front matter and saves it as a new version, so the change shows up everywhere, including synced folders and agents. Saving re-writes the whole front matter block, so its formatting may be tidied, and a date with a time becomes a plain date.

Dragging isn't available on a phone. Change the `date` in the note itself instead.

If someone else saved the note at the same moment, you'll see that it "changed on the server, so your reschedule was kept as a copy". The original keeps its date, and your version is saved as a [conflicted copy](/docs/files/conflicted-copies).

People viewing a [shared link](/docs/sharing/share-links) to the folder see the calendar too, but can't move anything.

## Troubleshooting

### Calendar doesn't appear in the switcher

No markdown file directly in the folder has a valid date. Check that the date is inside the front matter (between the `---` lines at the very top), is written `YYYY-MM-DD`, and is a real day. At the workspace root, the switcher only appears once the root has a `README.md`.