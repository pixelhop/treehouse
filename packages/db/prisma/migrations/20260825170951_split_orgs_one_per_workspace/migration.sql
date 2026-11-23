-- Data-only migration: make organizations 1:1 with workspaces.
--
-- Background. A Treehouse "workspace" is the file container users see; a
-- better-auth "organization" is a team of people (rows in "member"). Access to
-- a workspace is membership of its owning organization. Historically one
-- organization could own several workspaces, so inviting someone to share ONE
-- workspace silently granted them EVERY workspace in that organization. The
-- product now treats the workspace as the only user-facing container, with the
-- organization demoted to a hidden 1:1 carrier for one workspace's member list.
--
-- This migration reshapes existing data to match. For every workspace that is
-- not the oldest in its organization it creates a fresh organization, copies
-- the old organization's members into it, and re-parents the workspace onto it.
--
-- Invariants (asserted after the fact in the plan's validation step):
--   * No "workspace"."id" is ever changed, so every API key, share link, sync
--     link, encryption key and read-state row keeps working untouched.
--   * No row is ever deleted or merged. The migration only INSERTs organizations
--     and members and UPDATEs two foreign keys plus some display names, so even
--     a logic error here cannot destroy file data.
--   * Every user keeps exactly the workspaces they could reach before, because
--     the member list is copied verbatim into each split-off organization.
--
-- It is a natural no-op on a database that is already 1:1 (the driving SELECT
-- returns no rows, and the two repair UPDATEs match nothing).

-- 1. Give "Default"-named workspaces a distinguishable name BEFORE splitting.
--    The switcher is now a flat, cross-team list, so several workspaces all
--    called "Default" are indistinguishable. The owning organization's name
--    (e.g. "Jozef's Team") is the only personalised name available for existing
--    rows. Doing this first also means a split-off workspace carries the
--    personalised name into the organization created for it in step 2, instead
--    of minting an organization literally called "Default".
UPDATE "workspace" w
SET "name" = o."name"
FROM "organization" o
WHERE o."id" = w."organizationId"
  AND w."name" = 'Default';

-- 2. Pick the workspaces that must move: everything except the oldest workspace
--    in each organization (ties broken by id so the choice is deterministic).
--    The oldest stays put, which keeps the "original" organization — and any
--    better-auth session still pointing at it via activeOrganizationId — valid.
CREATE TEMPORARY TABLE "_org_split" AS
SELECT
  w."id"                    AS workspace_id,
  w."organizationId"        AS old_org_id,
  gen_random_uuid()::text   AS new_org_id,
  w."name"                  AS workspace_name
FROM "workspace" w
WHERE w."id" <> (
  SELECT w2."id"
  FROM "workspace" w2
  WHERE w2."organizationId" = w."organizationId"
  ORDER BY w2."createdAt" ASC, w2."id" ASC
  LIMIT 1
);

-- 3. Mint one organization per moving workspace, named after the workspace.
--    "slug" is deliberately left NULL: it is UNIQUE, nothing in the product
--    reads it, and every organization created before this migration has a NULL
--    slug anyway (Postgres allows unlimited NULLs under a unique index), so
--    leaving it out removes any chance of a collision aborting the migration.
INSERT INTO "organization" ("id", "name", "createdAt")
SELECT s.new_org_id, s.workspace_name, now()
FROM "_org_split" s;

-- 4. Copy the old organization's member list into each new organization, so
--    every person keeps exactly the access they had. Roles and join dates are
--    preserved. The source rows are unique per (organization, user), so the
--    unique(organizationId, userId) constraint cannot be violated here.
INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
SELECT gen_random_uuid()::text, s.new_org_id, m."userId", m."role", m."createdAt"
FROM "_org_split" s
JOIN "member" m ON m."organizationId" = s.old_org_id;

-- 5. Re-parent the workspace. Its id does not change; only which organization
--    holds its member list.
UPDATE "workspace" w
SET "organizationId" = s.new_org_id
FROM "_org_split" s
WHERE w."id" = s.workspace_id;

-- 6. Repair the denormalized organization id on invite links. Accepting an
--    invite resolves the organization through the workspace (see
--    packages/api/server/routes/api/invites/[token]/accept.post.ts), so a stale
--    value here is already harmless — but leaving obviously-wrong data in the
--    table would mislead the next reader.
UPDATE "workspace_invite" wi
SET "organizationId" = w."organizationId"
FROM "workspace" w
WHERE w."id" = wi."workspaceId"
  AND wi."organizationId" <> w."organizationId";

DROP TABLE "_org_split";
