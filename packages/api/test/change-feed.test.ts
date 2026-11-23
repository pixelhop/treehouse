import { describe, expect, it } from "vite-plus/test";
import "./env";

type ChangeEvent = import("db").ChangeEvent;
type AclRow = import("../server/utils/acl").AclRow;
type AccessSubject = import("../server/utils/acl").AccessSubject;

const { eventForReader } = await import("../server/utils/change-feed");

const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";

const member = (userId: string): AccessSubject => ({ userId, role: "member" });
const user = (userId: string, level: string) => ({ subject: "user", userId, level });
const folder = (path: string, ...grants: ReturnType<typeof user>[]): AclRow => ({
  path,
  kind: "folder",
  grants,
});

const event = (op: string, path: string, actorId: string = ALICE, privateTo?: string) =>
  ({ op, path, actorId, version: null, seq: 1n, privateTo }) as unknown as ChangeEvent;

const syncing = (acls: AclRow[], access: AccessSubject) => ({
  acls,
  access,
  includeComments: false,
  syncing: true,
});
const activity = (acls: AclRow[], access: AccessSubject) => ({
  ...syncing(acls, access),
  syncing: false,
});

describe("who hears about a restriction", () => {
  const acls = [folder("clients", user(ALICE, "write"), user(BOB, "read"))];

  it("tells someone who lost sight of it", () => {
    const got = eventForReader(event("access_revoked", "clients"), syncing(acls, member(CAROL)));
    expect(got?.op).toBe("access_revoked");
  });

  it("doesn't tell someone who keeps it", () => {
    expect(
      eventForReader(event("access_revoked", "clients"), syncing(acls, member(BOB))),
    ).toBeNull();
  });

  it("doesn't tell anyone once the restriction is gone", () => {
    expect(
      eventForReader(event("access_revoked", "clients"), syncing([], member(CAROL))),
    ).toBeNull();
  });

  it("doesn't name a child to someone who could never see its parent", () => {
    const nested = [
      folder("private", user(ALICE, "write")),
      folder("private/secret-project", user(ALICE, "write"), user(BOB, "read")),
    ];
    const path = "private/secret-project";
    expect(
      eventForReader(event("access_revoked", path), syncing(nested, member(CAROL))),
    ).toBeNull();
    expect(
      eventForReader(event("access_revoked", path), activity(nested, member(CAROL))),
    ).toBeNull();
  });
});

describe("a revocation over something the reader can still partly read", () => {
  // Bob can't read clients, but he holds a grant on a folder inside it.
  const acls = [
    folder("clients", user(ALICE, "write")),
    folder("clients/project", user(BOB, "write")),
  ];

  it("re-syncs a sync client rather than have it delete the subtree", () => {
    const got = eventForReader(event("access_revoked", "clients"), syncing(acls, member(BOB)));
    expect(got).toMatchObject({ op: "access_granted", path: "clients" });
  });

  it("leaves the activity feed saying what happened", () => {
    const got = eventForReader(event("access_revoked", "clients"), activity(acls, member(BOB)));
    expect(got?.op).toBe("access_revoked");
  });

  it("still tells someone with nothing left inside to drop it", () => {
    const got = eventForReader(event("access_revoked", "clients"), syncing(acls, member(CAROL)));
    expect(got?.op).toBe("access_revoked");
  });
});

describe("a grant taken away inside a folder the reader can't see", () => {
  // Only Alice can read private, and now only she can read private/shared.
  const acls = [
    folder("private", user(ALICE, "write")),
    folder("private/shared", user(ALICE, "write")),
  ];
  const before = JSON.stringify([user(ALICE, "write"), user(BOB, "read")]);
  const revoked = event("access_revoked", "private/shared", ALICE, before);

  it("tells the person who had it", () => {
    expect(eventForReader(revoked, syncing(acls, member(BOB)))?.op).toBe("access_revoked");
  });

  it("names it to nobody who never did", () => {
    expect(eventForReader(revoked, syncing(acls, member(CAROL)))).toBeNull();
  });

  it("names it to nobody on an event that didn't record who had it", () => {
    const old = event("access_revoked", "private/shared");
    expect(eventForReader(old, syncing(acls, member(BOB)))).toBeNull();
  });

  it("isn't news to anyone once they have it back", () => {
    const back = [
      folder("private", user(ALICE, "write")),
      folder("private/shared", user(BOB, "read")),
    ];
    expect(eventForReader(revoked, syncing(back, member(BOB)))).toBeNull();
  });
});

describe("a key confined to a folder", () => {
  const acls = [folder("clients", user(ALICE, "write"))];
  const keyed = (userId: string): AccessSubject => ({
    ...member(userId),
    keyScope: { access: "write", folder: "clients/acme" },
  });

  it("hears about a restriction above its folder, narrowed to the folder", () => {
    const got = eventForReader(event("access_revoked", "clients"), syncing(acls, keyed(BOB)));
    expect(got).toMatchObject({ op: "access_revoked", path: "clients/acme" });
  });

  it("isn't told about anything else outside its folder", () => {
    const got = eventForReader(event("access_revoked", "other"), syncing(acls, keyed(BOB)));
    expect(got).toBeNull();
  });
});

describe("other events", () => {
  const acls = [folder("clients", user(ALICE, "write"))];

  it("a file event reaches only those who can read it", () => {
    expect(
      eventForReader(event("write", "clients/a.md"), syncing(acls, member(ALICE))),
    ).not.toBeNull();
    expect(eventForReader(event("write", "clients/a.md"), syncing(acls, member(BOB)))).toBeNull();
  });

  it("access_granted skips the person who changed it", () => {
    const open: AclRow[] = [];
    expect(eventForReader(event("access_granted", "a"), syncing(open, member(ALICE)))).toBeNull();
    expect(eventForReader(event("access_granted", "a"), syncing(open, member(BOB)))).not.toBeNull();
  });

  it("access_claimed is for people who run the workspace, and never a sync client", () => {
    const owner: AccessSubject = { userId: BOB, role: "owner" };
    expect(
      eventForReader(event("access_claimed", "clients"), activity(acls, owner)),
    ).not.toBeNull();
    expect(eventForReader(event("access_claimed", "clients"), syncing(acls, owner))).toBeNull();
    expect(
      eventForReader(event("access_claimed", "clients"), activity(acls, member(BOB))),
    ).toBeNull();
  });

  it("comment traffic is opt-in", () => {
    const c = event("comment_created", "a.md");
    expect(eventForReader(c, syncing([], member(ALICE)))).toBeNull();
    const optedIn = { ...syncing([], member(ALICE)), includeComments: true };
    expect(eventForReader(c, optedIn)).not.toBeNull();
  });
});