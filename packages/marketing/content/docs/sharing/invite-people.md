---
title: Invite people to a workspace
navTitle: Invite people
description: Bring people into a workspace with an invite link, choose who can edit and who can only view, and remove them when they're done.
type: how-to
position: 1
updated: 2026-10-30
plans: [grove, forest]
related:
  - /docs/sharing/share-links
  - /docs/account/billing
  - /docs/agents/connect/api-keys
---

::callout{type="note"}
Inviting people needs a paid plan, Grove or Forest. A Seedling workspace is for one person (and their agents), so creating an invite link there shows **Your plan is for one person** with a way to upgrade. To give someone read-only access to a single file or folder instead, [share a link](/docs/sharing/share-links). That works on every plan.
::

An invite link joins someone to one workspace: the one you create it from. Your other workspaces stay private.

## Steps

1. Open the account menu at the bottom of the sidebar and choose **Dashboard**.
2. Check the workspace switcher shows the workspace you want to invite people to. The card reads **Invite someone to** followed by its name.
3. Under **They can**, choose **edit files** or **view and comment only**. The second joins them as a [Viewer](#roles).
4. Select **Create invite link**.
5. Select **Copy** and send the link to your teammate however you like.

![The Dashboard's invite card, showing a new invite link with a Copy button and its expiry date](/docs/images/invite-link.webp)

Under the link you'll see **Expires** with a date, and "Anyone with the link can join until then." Every invite link:

- lasts **7 days**;
- can be used by any number of people until it expires;
- gives each person who joins the role you chose when you created it.

Any member of the workspace can create one, except Viewers. Select **Create another** for a fresh link, for example to give each person their own.

::callout{type="warning"}
Treat an invite link like a key. There's currently no way to list or cancel outstanding links in the app, so anyone who has one can join until it expires 7 days after you created it.
::

## What your teammate sees

1. They open the link. If they aren't signed in, they're asked to sign in first and then brought back. If they need to create an account, they should open the link again once they have.
2. They see **Join** followed by the workspace name, and select **Accept invite**. A Viewer link tells them they'll be able to read and comment, but not change anything.
3. They see **You're in 🌳**. On an Apple silicon Mac they're offered **Open in Treehouse** and **Download for Mac (Apple Silicon)** to [sync the workspace to a folder](/docs/desktop/install-the-desktop-app). Everyone can open the workspace in the browser straight away.

If the link has a problem, they see **Invite unavailable** with the reason, such as "This invite link has expired." Ask a member for a new link. Someone who's already a member can open an old link at any time: it just takes them in.

## Seats and billing

On a paid plan, every member is a seat, including Viewers. When someone accepts an invite, a seat is added to the workspace's bill straight away, charged pro rata for the rest of the billing period. Removing someone takes the seat off the same way. The price per seat is shown on the invite card and in the members panel. Agents and the people you share links with don't count as seats.

See [billing](/docs/account/billing) for the details.

## Roles

Each member has one of four roles, shown next to their name in the members panel:

| Role       | What they can do                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**  | Everything a member can, plus remove members (including other owners), change roles and manage billing. The person who created the workspace is its owner.                  |
| **Admin**  | Everything a member can, plus remove members (but not owners), change roles and manage billing.                                                                             |
| **Member** | Read and write every file except [private and restricted ones](/docs/files/private-files) they aren't on, comment, create invite links and share links, and connect agents. |
| **Viewer** | Read every file except private and restricted ones they aren't on, see history and activity, comment, sync a folder and connect agents. They can't change anything.         |

Owners and admins don't get to see [private and restricted files](/docs/files/private-files) they aren't on. Their role doesn't get them in.

### What a Viewer can't do

A Viewer can't create, edit, upload, move, rename, delete or restore files, bring back anything from the trash, undo an agent's changes, make anything private, create or revoke share links, change icons or the workspace's name and appearance, or create invite links.

Comments are the exception, on purpose. Reviewing is the main reason to invite someone as a Viewer, and a comment doesn't change the file. Viewers can comment, reply and resolve threads.

The same limits follow them everywhere. Their [API keys](/docs/agents/connect/api-keys) and agents can't change anything either, and a folder they sync won't upload their edits: see [syncing with view-only access](/docs/desktop/how-sync-works#syncing-with-view-only-access).

To let someone read a single file or folder without joining the workspace at all, use a [share link](/docs/sharing/share-links).

## Change someone's role

1. Open the account menu and choose **Members**.
2. Choose **Member** or **Viewer** next to their name.

Only owners and admins can do this, and it takes effect straight away, including for any agents and synced folders using their access. You can't change your own role or an owner's, and only an owner can change an admin's. Nobody can be made an owner or admin in the app.

## See and remove members

Open the account menu and choose **Members** to see **Who can see** the workspace and each person's role.

![The Members panel, listing each member with their role and a Remove button](/docs/images/members.webp)

Owners and admins see **Remove** next to people they can remove. An admin can't remove an owner, only an owner can, and a workspace always keeps at least one owner. You'll be asked to confirm: "They'll lose access to its files, and any folder they sync from it will stop syncing."

To leave a workspace yourself: if you're an owner or admin, select **Leave** next to your own name. If you're a member, ask an owner or admin to remove you. The last owner can't leave.

## What happens when someone is removed

- They lose access to the workspace's files straight away, in the web app, over MCP and through the API.
- Any folder they sync from it stops syncing. The files already on their computer stay there.
- Keys tied to this workspace, such as their desktop app and CLI device keys, are deleted.
- Their account-wide [API keys](/docs/agents/connect/api-keys) and [connected agents](/docs/agents/connect/connected-agents) stop working for this workspace, though they still work for any other workspace they belong to.
- Their past changes, comments and history stay, so the [activity feed](/docs/sharing/activity) still shows who did what.
- Their other workspaces aren't affected.

## Troubleshooting

### Why does creating a link say "Your plan is for one person"?

The workspace is on Seedling, which allows one member. An owner or admin can [upgrade to Grove or Forest](/docs/account/billing) from the same notice.

### My teammate's link says it has expired. What now?

Links last 7 days. Create a new one from the **Dashboard** and send that instead.