import { describe, expect, it } from "vite-plus/test";
import { asMember } from "./access";
import "./env";

type GrantRow = import("../server/utils/acl").GrantRow;
type AccessSubject = import("../server/utils/acl").AccessSubject;
type WorkspaceRole = import("../server/utils/acl").WorkspaceRole;

const { usePrismaClient } = await import("db");
const {
  aclCovers,
  accessLevel,
  effectiveAcl,
  grantLevel,
  isPrivateTo,
  anyWriteRefusal,
  decodeGrants,
  encodeGrants,
  orphanedRestrictions,
  restrictionsFor,
  parseKeyScope,
  parseRole,
  roleChangeRefusal,
  workspaceWriteRefusal,
  writeRefusal,
  canRead,
  canWrite,
  listWorkspaceAcls,
  getNodeAcl,
  setNodePrivate,
  clearNodePrivate,
  moveFolderMetadata,
} = await import("../server/utils/acl");

const db = usePrismaClient();

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

const OWNER = "user_owner";
const OTHER = "user_other";
const VIEWER_GRANTEE = "user_view_grantee";
const BLOCKED = "user_blocked";

const member = (userId: string): AccessSubject => ({ userId, role: "member" });

describe("aclCovers", () => {
  it("folder ACL covers the folder and its subtree only", () => {
    const acl = { path: "journal", kind: "folder" };
    expect(aclCovers(acl, "journal")).toBe(true);
    expect(aclCovers(acl, "journal/today.md")).toBe(true);
    expect(aclCovers(acl, "journal/2026/q2.md")).toBe(true);
  });
  it("folder ACL rejects sibling-prefix paths and escapes", () => {
    const acl = { path: "journal", kind: "folder" };
    expect(aclCovers(acl, "journal2/secret.md")).toBe(false);
    expect(aclCovers(acl, "other.md")).toBe(false);
    expect(aclCovers(acl, "../escape")).toBe(false);
    expect(aclCovers(acl, "journal/../../escape")).toBe(false);
  });
  it("file ACL covers only its exact path", () => {
    const acl = { path: "notes/a.md", kind: "file" };
    expect(aclCovers(acl, "notes/a.md")).toBe(true);
    expect(aclCovers(acl, "notes/a.md/x")).toBe(false);
    expect(aclCovers(acl, "notes")).toBe(false);
  });
});

type Row = { path: string; kind: string; grants: GrantRow[] };

const user = (userId: string, level: string): GrantRow => ({ subject: "user", userId, level });
const everyone = (level: string): GrantRow => ({ subject: "everyone", userId: null, level });
const restrict = (path: string, grants: GrantRow[], kind = "folder"): Row => ({
  path,
  kind,
  grants,
});
const privateTo = (path: string, owner: string, kind = "folder") =>
  restrict(path, [user(owner, "write")], kind);

describe("effectiveAcl", () => {
  it("returns the most specific (longest) covering restriction", () => {
    const acls = [privateTo("journal", OWNER), privateTo("journal/shared", OTHER)];
    expect(effectiveAcl(acls, "journal/today.md")?.path).toBe("journal");
    expect(effectiveAcl(acls, "journal/shared/x.md")?.path).toBe("journal/shared");
  });
  it("returns null when nothing governs the path", () => {
    expect(effectiveAcl([privateTo("journal", OWNER)], "projects/acme.md")).toBeNull();
  });
  it("returns null for a path that won't normalize", () => {
    expect(effectiveAcl([privateTo("journal", OWNER)], "../journal")).toBeNull();
  });
});

describe("grantLevel", () => {
  const table: [string, GrantRow[], string, string][] = [
    ["own grant", [user(OWNER, "read")], OWNER, "read"],
    ["someone else's grant", [user(OTHER, "write")], OWNER, "none"],
    ["no grants admits nobody", [], OWNER, "none"],
    ["everyone grant", [everyone("read")], OWNER, "read"],
    ["own grant beats a wider everyone", [user(OWNER, "read"), everyone("write")], OWNER, "read"],
    [
      "own grant beats everyone, either order",
      [everyone("write"), user(OWNER, "read")],
      OWNER,
      "read",
    ],
    ["an explicit none beats everyone", [everyone("read"), user(OWNER, "none")], OWNER, "none"],
    ["unknown level is none", [user(OWNER, "admin")], OWNER, "none"],
    ["unknown everyone level is none", [everyone("everything")], OWNER, "none"],
  ];
  it.each(table)("%s", (_name, grants, userId, expected) => {
    expect(grantLevel({ grants }, userId)).toBe(expected);
  });
});

describe("parseRole", () => {
  const table: [string | null | undefined, string][] = [
    ["owner", "owner"],
    ["admin", "admin"],
    ["member", "member"],
    ["viewer", "viewer"],
    ["admin,member", "admin"],
    ["viewer, member", "member"],
    [" owner ", "owner"],
    // Anything unrecognised can only narrow.
    ["superuser", "viewer"],
    ["", "viewer"],
    [null, "viewer"],
    [undefined, "viewer"],
    ["constructor", "viewer"],
    ["__proto__", "viewer"],
  ];
  it.each(table)("%s -> %s", (raw, expected) => {
    expect(parseRole(raw)).toBe(expected);
  });
});

describe("roleChangeRefusal", () => {
  const table: [string, string, boolean, string | null][] = [
    ["owner", "member", false, null],
    ["owner", "viewer", false, null],
    ["owner", "admin", false, null],
    ["admin", "member", false, null],
    ["admin", "viewer", false, null],
    ["admin", "admin", false, "peer_admin"],
    ["admin", "owner", false, "owner_role"],
    ["owner", "owner", false, "owner_role"],
    ["owner", "owner", true, "own_role"],
    ["admin", "admin", true, "own_role"],
    ["member", "viewer", false, "not_a_manager"],
    ["viewer", "member", false, "not_a_manager"],
    ["viewer", "viewer", true, "not_a_manager"],
  ];
  it.each(table)("%s changing %s (self: %s)", (caller, target, self, expected) => {
    expect(roleChangeRefusal(caller as WorkspaceRole, target as WorkspaceRole, self)).toBe(
      expected,
    );
  });
});

describe("accessLevel", () => {
  const acls = [
    privateTo("journal", OWNER),
    restrict("clients", [user(OWNER, "write"), user(VIEWER_GRANTEE, "read")]),
    restrict("clients/open", [everyone("write")]),
    restrict("handbook", [everyone("read"), user(OWNER, "write"), user(BLOCKED, "none")]),
    restrict("secret.md", [user(OWNER, "read")], "file"),
    restrict("orphan", []),
  ];
  const asOwner = { userId: OWNER, role: "owner" } as const;
  const asAdmin = { userId: OTHER, role: "admin" } as const;
  const member = { userId: OTHER, role: "member" } as const;
  const viewer = { userId: OTHER, role: "viewer" } as const;
  const ownerAsViewer = { userId: OWNER, role: "viewer" } as const;

  const table: [string, string, AccessSubject | "trusted" | null | undefined, string][] = [
    // Open by default.
    ["open path, member", "projects/a.md", member, "write"],
    ["open path, admin", "projects/a.md", asAdmin, "write"],
    ["open path, viewer is capped to read", "projects/a.md", viewer, "read"],
    ["sibling sharing the prefix is open", "journal2/a.md", member, "write"],
    // Private (a single write grant).
    ["private, its owner", "journal/a.md", asOwner, "write"],
    ["private, the folder itself", "journal", asOwner, "write"],
    ["private, deep descendant", "journal/2026/q2.md", asOwner, "write"],
    ["private, another member", "journal/a.md", member, "none"],
    // No bypass: owners and admins hold no implicit access.
    ["private, a workspace admin", "journal/a.md", asAdmin, "none"],
    [
      "private to someone else, workspace owner",
      "journal/a.md",
      { userId: "u3", role: "owner" },
      "none",
    ],
    ["orphaned restriction, workspace owner", "orphan/a.md", asOwner, "none"],
    // Named grants.
    ["view grant", "clients/acme.md", { userId: VIEWER_GRANTEE, role: "member" }, "read"],
    ["edit grant", "clients/acme.md", asOwner, "write"],
    ["no grant", "clients/acme.md", member, "none"],
    // Most specific wins, and replaces rather than adds.
    ["nested restriction opens up", "clients/open/a.md", member, "write"],
    ["nested restriction narrows an editor", "secret.md", asOwner, "read"],
    // Everyone grants.
    ["everyone read", "handbook/a.md", member, "read"],
    ["everyone read, with an edit grant", "handbook/a.md", asOwner, "write"],
    [
      "everyone read, explicitly excluded",
      "handbook/a.md",
      { userId: BLOCKED, role: "member" },
      "none",
    ],
    // A key's scope only ever narrows, whatever the person could do.
    [
      "read-only key on an open path",
      "projects/a.md",
      { ...member, keyScope: { access: "read", folder: null } },
      "read",
    ],
    [
      "read-only key on the owner's edit grant",
      "journal/a.md",
      { ...asOwner, keyScope: { access: "read", folder: null } },
      "read",
    ],
    [
      "a key can't reach what its person can't",
      "journal/a.md",
      { ...member, keyScope: { access: "write", folder: null } },
      "none",
    ],
    [
      "a viewer's write key still can't write",
      "projects/a.md",
      { ...viewer, keyScope: { access: "write", folder: null } },
      "read",
    ],
    [
      "inside the key's folder",
      "journal/a.md",
      { ...asOwner, keyScope: { access: "write", folder: "journal" } },
      "write",
    ],
    [
      "read-only in the key's folder",
      "journal/a.md",
      { ...asOwner, keyScope: { access: "read", folder: "journal" } },
      "read",
    ],
    [
      "outside the key's folder",
      "projects/a.md",
      { ...member, keyScope: { access: "write", folder: "journal" } },
      "none",
    ],
    [
      "a sibling sharing the folder's prefix",
      "journal2/a.md",
      { ...asOwner, keyScope: { access: "write", folder: "journal" } },
      "none",
    ],
    [
      "the parent of the key's folder",
      "clients",
      { ...asOwner, keyScope: { access: "write", folder: "clients/open" } },
      "none",
    ],
    // The role caps a grant.
    ["viewer with an edit grant", "journal/a.md", ownerAsViewer, "read"],
    ["viewer with everyone:write", "clients/open/a.md", viewer, "read"],
    ["viewer with no grant", "journal/a.md", viewer, "none"],
    // File restrictions.
    ["file restriction, exact path", "secret.md", member, "none"],
    ["file restriction doesn't cover a sibling", "secret.md.bak", member, "write"],
    // Fail closed.
    ["missing subject on an open path", "projects/a.md", null, "none"],
    ["undefined subject on an open path", "projects/a.md", undefined, "none"],
    ["empty user id", "projects/a.md", { userId: "", role: "member" }, "none"],
    ["traversal", "../journal/a.md", asOwner, "none"],
    ["traversal into a private folder", "journal/../../x", asOwner, "none"],
    // Trusted callers skip the grants, not the path check.
    ["trusted on a restricted path", "journal/a.md", "trusted", "write"],
    ["trusted on a bad path", "../x", "trusted", "none"],
  ];
  it.each(table)("%s", (_name, path, subject, expected) => {
    expect(accessLevel(acls, path, subject)).toBe(expected);
    expect(canRead(acls, path, subject)).toBe(expected !== "none");
    expect(canWrite(acls, path, subject)).toBe(expected === "write");
  });
});

describe("writeRefusal", () => {
  const acls = [privateTo("journal", OWNER), restrict("clients", [user(OTHER, "read")])];
  const roleDenied = { error: "read_only", reason: "role" };
  const grantDenied = { error: "read_only", reason: "grant" };
  const keyDenied = { error: "read_only", reason: "key" };
  const member = { userId: OTHER, role: "member" } as const;
  const viewer = { userId: OTHER, role: "viewer" } as const;
  const readKey = { access: "read", folder: null } as const;
  const folderKey = { access: "write", folder: "projects" } as const;
  const table: [string, string, AccessSubject, unknown][] = [
    ["allowed", "projects/a.md", member, null],
    ["hidden", "journal/a.md", member, "hidden"],
    ["viewer role", "projects/a.md", viewer, roleDenied],
    ["view-only grant", "clients/a.md", member, grantDenied],
    ["read-only key", "projects/a.md", { ...member, keyScope: readKey }, keyDenied],
    // Most fundamental first: what would have to change for the write to work.
    ["viewer inside a view-only grant", "clients/a.md", viewer, roleDenied],
    ["viewer on a read-only key", "projects/a.md", { ...viewer, keyScope: readKey }, roleDenied],
    [
      "view-only grant on a read-only key",
      "clients/a.md",
      { ...member, keyScope: readKey },
      grantDenied,
    ],
    // Hidden wins: a viewer or a read-only key must not learn a node exists.
    ["viewer on a hidden node", "journal/a.md", viewer, "hidden"],
    ["read-only key on a hidden node", "journal/a.md", { ...member, keyScope: readKey }, "hidden"],
    // Inside a folder key's reach, it behaves like any other key.
    ["inside the key's folder", "projects/a.md", { ...member, keyScope: folderKey }, null],
    // Outside it comes first, and depends only on the key, so even a hidden node
    // gets this answer: it can't be told apart from one that doesn't exist.
    [
      "outside the key's folder",
      "other/a.md",
      { ...member, keyScope: folderKey },
      { error: "outside_key_folder", folder: "projects" },
    ],
    [
      "a hidden node outside the key's folder",
      "journal/a.md",
      { ...member, keyScope: folderKey },
      { error: "outside_key_folder", folder: "projects" },
    ],
    [
      "a sibling sharing the folder's prefix",
      "projects2/a.md",
      { ...member, keyScope: folderKey },
      { error: "outside_key_folder", folder: "projects" },
    ],
  ];
  it.each(table)("%s", (_name, path, subject, expected) => {
    expect(writeRefusal(acls, path, subject)).toEqual(expected);
  });
  it("treats a missing subject as hidden", () => {
    expect(writeRefusal(acls, "projects/a.md", null)).toEqual("hidden");
  });
});

describe("parseKeyScope", () => {
  const table: [string, unknown, unknown][] = [
    ["no scope", undefined, null],
    ["null scope", null, null],
    ["read-only", { access: "read" }, { access: "read", folder: null }],
    ["a folder", { access: "write", folder: "a/b" }, { access: "write", folder: "a/b" }],
    ["null folder", { access: "read", folder: null }, { access: "read", folder: null }],
    // Anything else is invalid, never "no scope": that would widen the key.
    ["unknown access", { access: "admin" }, "invalid"],
    ["no access", { folder: "a" }, "invalid"],
    ["empty folder", { access: "read", folder: "" }, "invalid"],
    ["traversal", { access: "read", folder: "a/../../b" }, "invalid"],
    ["unnormalized", { access: "read", folder: "a//b/" }, "invalid"],
    ["non-string folder", { access: "read", folder: 7 }, "invalid"],
    ["a string", "read", "invalid"],
  ];
  it.each(table)("%s", (_name, raw, expected) => {
    expect(parseKeyScope(raw)).toEqual(expected);
  });
});

describe("workspace-level refusals", () => {
  const member = { userId: OWNER, role: "member" } as const;
  it("a viewer or read-only key can change nothing", () => {
    expect(anyWriteRefusal({ ...member, role: "viewer" })).toEqual({
      error: "read_only",
      reason: "role",
    });
    expect(anyWriteRefusal({ ...member, keyScope: { access: "read", folder: null } })).toEqual({
      error: "read_only",
      reason: "key",
    });
    expect(anyWriteRefusal(member)).toBeNull();
  });
  it("a folder key can write in its folder but not change the workspace", () => {
    const subject = { ...member, keyScope: { access: "write", folder: "a" } } as const;
    expect(anyWriteRefusal(subject)).toBeNull();
    expect(workspaceWriteRefusal(subject)).toEqual({ error: "outside_key_folder", folder: "a" });
    expect(workspaceWriteRefusal(member)).toBeNull();
  });
});

describe("encodeGrants / decodeGrants", () => {
  const table: [string, GrantRow[]][] = [
    ["private to one person", [user(OWNER, "write")]],
    ["two people", [user(OWNER, "write"), user(OTHER, "read")]],
    ["one person at read", [user(OWNER, "read")]],
    ["everyone", [user(OWNER, "write"), everyone("read")]],
    ["nobody", []],
  ];
  it.each(table)("%s round-trips", (_name, grants) => {
    const decoded = decodeGrants(encodeGrants({ grants }));
    for (const id of [OWNER, OTHER, "user_stranger"]) {
      expect(grantLevel({ grants: decoded }, id)).toBe(grantLevel({ grants }, id));
    }
  });
  it("is unrestricted only when there's no restriction at all", () => {
    expect(encodeGrants(null)).toBe("");
    expect(decodeGrants("")).toEqual([]);
    // No grants means nobody, which must not read as the "" of unrestricted.
    expect(encodeGrants({ grants: [] })).not.toBe("");
  });
  it("keeps a private owner as a bare id, which is what older events hold", () => {
    expect(encodeGrants({ grants: [user(OWNER, "write")] })).toBe(OWNER);
    expect(decodeGrants(OWNER)).toEqual([user(OWNER, "write")]);
  });
  it("doesn't depend on the order the grants came back in", () => {
    const a = [user(OWNER, "write"), user(OTHER, "read")];
    expect(encodeGrants({ grants: a })).toBe(encodeGrants({ grants: [...a].reverse() }));
  });
  it("reads something unreadable as nobody", () => {
    expect(decodeGrants("[not json")).toEqual([]);
    expect(decodeGrants('[{"subject":"user"}]')).toEqual([{ subject: "user" }]);
    expect(grantLevel({ grants: decodeGrants("[not json") }, OWNER)).toBe("none");
  });
});

describe("orphanedRestrictions", () => {
  const members = new Set([OWNER, OTHER]);
  const table: [string, GrantRow[], boolean][] = [
    ["a member holds it", [user(OWNER, "read")], false],
    ["a member and someone who left", [user("left", "write"), user(OWNER, "read")], false],
    ["only people who left", [user("left", "write")], true],
    ["nobody at all", [], true],
    ["open to everyone", [user("left", "write"), everyone("read")], false],
    ["everyone at none", [user("left", "write"), everyone("none")], true],
    ["a member excluded", [user(OWNER, "none")], true],
    [
      "open to everyone, but every member is excluded",
      [everyone("read"), user(OWNER, "none"), user(OTHER, "none")],
      true,
    ],
    ["open to everyone, one member excluded", [everyone("read"), user(OWNER, "none")], false],
  ];
  it.each(table)("%s", (_name, grants, expected) => {
    const acl = restrict("clients", grants);
    expect(orphanedRestrictions([acl], members).length === 1).toBe(expected);
  });
});

describe("restrictionsFor", () => {
  it("only lists restrictions the subject can read, with how far it reaches", () => {
    const acls = [restrict("clients", [user(OTHER, "read")]), privateTo("journal", OWNER)];
    expect(restrictionsFor(acls, { userId: OTHER, role: "member" })).toEqual([
      { path: "clients", kind: "folder", level: "read", grants: [user(OTHER, "read")] },
    ]);
  });
  it("a folder key doesn't learn about restrictions outside its folder", () => {
    const acls = [restrict("clients", [user(OTHER, "write")])];
    const subject = {
      userId: OTHER,
      role: "member",
      keyScope: { access: "write", folder: "open" },
    } as const;
    expect(restrictionsFor(acls, subject)).toEqual([]);
  });
});

describe("isPrivateTo", () => {
  const table: [string, GrantRow[], boolean][] = [
    ["only me at write", [user(OWNER, "write")], true],
    ["only me at read", [user(OWNER, "read")], false],
    ["me and someone else", [user(OWNER, "write"), user(OTHER, "read")], false],
    ["me and everyone", [user(OWNER, "write"), everyone("read")], false],
    ["someone else", [user(OTHER, "write")], false],
    ["nobody", [], false],
  ];
  it.each(table)("%s", (_name, grants, expected) => {
    expect(isPrivateTo({ grants }, OWNER)).toBe(expected);
  });
});

describe("ACL persistence", () => {
  it("setNodePrivate, getNodeAcl, listWorkspaceAcls, clearNodePrivate round-trip", async () => {
    const ws = await freshWorkspace();
    await setNodePrivate({ workspaceId: ws.id, path: "journal", kind: "folder", ownerId: OWNER });

    const row = await getNodeAcl(ws.id, "journal");
    expect(row?.grants).toEqual([{ subject: "user", userId: OWNER, level: "write" }]);
    expect(row?.kind).toBe("folder");

    const all = await listWorkspaceAcls(ws.id);
    expect(all).toHaveLength(1);
    expect(canRead(all, "journal/today.md", member(OTHER))).toBe(false);

    // Upsert is idempotent and can re-point the owner.
    await setNodePrivate({ workspaceId: ws.id, path: "journal", kind: "folder", ownerId: OTHER });
    expect((await getNodeAcl(ws.id, "journal"))?.grants).toEqual([
      { subject: "user", userId: OTHER, level: "write" },
    ]);

    expect(await clearNodePrivate(ws.id, "journal")).toBe(true);
    expect(await getNodeAcl(ws.id, "journal")).toBeNull();
    expect(await clearNodePrivate(ws.id, "journal")).toBe(false);
  });
});
describe("access-revocation signal (U6)", () => {
  it("setNodePrivate with an actor records an access_revoked change event", async () => {
    const ws = await freshWorkspace();
    await setNodePrivate({
      workspaceId: ws.id,
      path: "journal",
      kind: "folder",
      ownerId: OWNER,
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
    });
    const ev = await db.changeEvent.findFirst({
      where: { workspaceId: ws.id, op: "access_revoked", path: "journal" },
    });
    expect(ev?.actorId).toBe(OWNER);
  });

  it("does not record a change event when no actor is supplied", async () => {
    const ws = await freshWorkspace();
    await setNodePrivate({ workspaceId: ws.id, path: "a", kind: "folder", ownerId: OWNER });
    const ev = await db.changeEvent.findFirst({
      where: { workspaceId: ws.id, op: "access_revoked" },
    });
    expect(ev).toBeNull();
  });
});

describe("access-grant signal (unmark private)", () => {
  it("clearNodePrivate with an actor records an access_granted change event", async () => {
    const ws = await freshWorkspace();
    await setNodePrivate({ workspaceId: ws.id, path: "journal", kind: "folder", ownerId: OWNER });
    expect(
      await clearNodePrivate(ws.id, "journal", {
        principal: "human",
        actorId: OWNER,
        access: asMember(OWNER),
      }),
    ).toBe(true);
    const ev = await db.changeEvent.findFirst({
      where: { workspaceId: ws.id, op: "access_granted", path: "journal" },
    });
    expect(ev?.actorId).toBe(OWNER);
  });

  it("emits no grant event when nothing was actually cleared", async () => {
    const ws = await freshWorkspace();
    expect(
      await clearNodePrivate(ws.id, "never-private", {
        principal: "human",
        actorId: OWNER,
        access: asMember(OWNER),
      }),
    ).toBe(false);
    const ev = await db.changeEvent.findFirst({
      where: { workspaceId: ws.id, op: "access_granted" },
    });
    expect(ev).toBeNull();
  });
});

describe("moveFolderMetadata (folder rename re-paths ACL + meta)", () => {
  it("re-paths the folder's own ACL and a nested folder ACL to the new prefix", async () => {
    const ws = await freshWorkspace();
    await setNodePrivate({ workspaceId: ws.id, path: "journal", kind: "folder", ownerId: OWNER });
    await setNodePrivate({
      workspaceId: ws.id,
      path: "journal/2026",
      kind: "folder",
      ownerId: OWNER,
    });

    await moveFolderMetadata(ws.id, "journal", "archive");

    // Old paths are gone; the moved subtree is private again at its new location.
    expect(await getNodeAcl(ws.id, "journal")).toBeNull();
    const owned = [{ subject: "user", userId: OWNER, level: "write" }];
    expect((await getNodeAcl(ws.id, "archive"))?.grants).toEqual(owned);
    expect((await getNodeAcl(ws.id, "archive/2026"))?.grants).toEqual(owned);
    const acls = await listWorkspaceAcls(ws.id);
    expect(canRead(acls, "archive/2026/q2.md", member(OTHER))).toBe(false);
    expect(canRead(acls, "journal/old.md", member(OTHER))).toBe(true); // no longer governed
  });

  it("re-paths node_meta (icons/order) under the moved folder", async () => {
    const ws = await freshWorkspace();
    await db.nodeMeta.create({
      data: { workspaceId: ws.id, path: "journal", icon: "📓", order: 2 },
    });
    await moveFolderMetadata(ws.id, "journal", "archive");
    expect(
      await db.nodeMeta.findUnique({
        where: { workspaceId_path: { workspaceId: ws.id, path: "journal" } },
      }),
    ).toBeNull();
    const moved = await db.nodeMeta.findUnique({
      where: { workspaceId_path: { workspaceId: ws.id, path: "archive" } },
    });
    expect(moved?.icon).toBe("📓");
  });

  it("leaves a file-kind ACL alone (FileService.move carries those)", async () => {
    const ws = await freshWorkspace();
    await setNodePrivate({
      workspaceId: ws.id,
      path: "journal/a.md",
      kind: "file",
      ownerId: OWNER,
    });
    await moveFolderMetadata(ws.id, "journal", "archive");
    // The file-kind ACL is untouched by the folder re-path (no double-handling).
    expect((await getNodeAcl(ws.id, "journal/a.md"))?.kind).toBe("file");
    expect(await getNodeAcl(ws.id, "archive/a.md")).toBeNull();
  });
});