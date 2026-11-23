import { describe, expect, it } from "vite-plus/test";
import "./env";

const { usePrismaClient } = await import("db");
const {
  createShare,
  listShares,
  listInheritedShares,
  revokeShare,
  resolveShare,
  isWithinShare,
  hashSharePassword,
  verifySharePassword,
  newShareToken,
  signShareUnlock,
  verifyShareUnlock,
} = await import("../server/utils/shares");

const db = usePrismaClient();

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

describe("isWithinShare", () => {
  it("folder share admits the folder and its subtree only", () => {
    const share = { path: "dir", kind: "folder" };
    expect(isWithinShare(share, "dir")).toBe(true);
    expect(isWithinShare(share, "dir/a.md")).toBe(true);
    expect(isWithinShare(share, "dir/sub/b.md")).toBe(true);
  });
  it("folder share rejects sibling-prefix paths and escapes", () => {
    const share = { path: "dir", kind: "folder" };
    expect(isWithinShare(share, "dir2/secret.md")).toBe(false); // sibling sharing the prefix
    expect(isWithinShare(share, "other.md")).toBe(false);
    expect(isWithinShare(share, "../escape")).toBe(false);
    expect(isWithinShare(share, "dir/../../escape")).toBe(false);
  });
  it("file share admits only its exact path", () => {
    const share = { path: "a.md", kind: "file" };
    expect(isWithinShare(share, "a.md")).toBe(true);
    expect(isWithinShare(share, "b.md")).toBe(false);
    expect(isWithinShare(share, "a.md/x")).toBe(false);
  });
});

describe("share passwords", () => {
  it("verifies the correct password and rejects wrong ones", () => {
    const stored = hashSharePassword("correct horse");
    expect(stored).toContain(":");
    expect(verifySharePassword("correct horse", stored)).toBe(true);
    expect(verifySharePassword("wrong", stored)).toBe(false);
  });
  it("rejects against a null or malformed hash", () => {
    expect(verifySharePassword("x", null)).toBe(false);
    expect(verifySharePassword("x", "garbage")).toBe(false);
  });
});

describe("share tokens", () => {
  it("are url-safe and carry >=128 bits of entropy", () => {
    const t = newShareToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(22);
  });
});

describe("token-bound unlock cookie", () => {
  it("verifies its own token's signature and rejects another token's", () => {
    const a = newShareToken();
    const b = newShareToken();
    const sigA = signShareUnlock(a);
    expect(verifyShareUnlock(a, sigA)).toBe(true);
    expect(verifyShareUnlock(b, sigA)).toBe(false); // share A's cookie can't unlock share B
    expect(verifyShareUnlock(a, undefined)).toBe(false);
    expect(verifyShareUnlock(a, "deadbeef")).toBe(false);
  });
});

describe("share CRUD", () => {
  it("creates member + public + password shares; views never leak passwordHash", async () => {
    const ws = await freshWorkspace();
    const member = await createShare({
      workspaceId: ws.id,
      path: "doc.md",
      kind: "file",
      access: "member",
      createdBy: "u1",
    });
    expect(member.token).toBeNull();
    expect(member.hasPassword).toBe(false);

    const pub = await createShare({
      workspaceId: ws.id,
      path: "dir",
      kind: "folder",
      access: "public",
      createdBy: "u1",
    });
    expect(pub.token).toBeTruthy();

    const pw = await createShare({
      workspaceId: ws.id,
      path: "secret.md",
      kind: "file",
      access: "public",
      password: "hunter2",
      createdBy: "u1",
    });
    expect(pw.hasPassword).toBe(true);
    for (const v of [member, pub, pw]) expect(v).not.toHaveProperty("passwordHash");
  });

  it("lists active shares for a path and excludes revoked", async () => {
    const ws = await freshWorkspace();
    const s = await createShare({
      workspaceId: ws.id,
      path: "f.md",
      kind: "file",
      access: "public",
      createdBy: "u1",
    });
    expect((await listShares(ws.id, "f.md")).length).toBe(1);
    expect(await revokeShare(ws.id, s.id)).toBe(true);
    expect(await listShares(ws.id, "f.md")).toEqual([]);
  });

  it("resolveShare returns active shares and null for revoked/unknown tokens", async () => {
    const ws = await freshWorkspace();
    const s = await createShare({
      workspaceId: ws.id,
      path: "g.md",
      kind: "file",
      access: "public",
      password: "pw",
      createdBy: "u1",
    });
    const token = s.token as string;
    const resolved = await resolveShare(token);
    expect(resolved?.id).toBe(s.id);
    expect(verifySharePassword("pw", resolved?.passwordHash ?? null)).toBe(true);

    expect(await resolveShare("nope-not-a-token")).toBeNull();
    await revokeShare(ws.id, s.id);
    expect(await resolveShare(token)).toBeNull();
  });

  it("listInheritedShares returns ancestor folder shares covering a path, deepest-first", async () => {
    const ws = await freshWorkspace();
    const outer = await createShare({
      workspaceId: ws.id,
      path: "a",
      kind: "folder",
      access: "public",
      createdBy: "u1",
    });
    const inner = await createShare({
      workspaceId: ws.id,
      path: "a/b",
      kind: "folder",
      access: "public",
      createdBy: "u1",
    });
    // A file's own share is NOT inherited; both ancestor folders are.
    const inherited = await listInheritedShares(ws.id, "a/b/c.md");
    expect(inherited.map((s) => s.id).sort()).toEqual([outer.id, inner.id].sort());

    // A top-level path has no ancestors.
    expect(await listInheritedShares(ws.id, "top.md")).toEqual([]);

    // A file share on an ancestor does NOT count (only folders cover children).
    const ws2 = await freshWorkspace();
    await createShare({
      workspaceId: ws2.id,
      path: "a",
      kind: "file",
      access: "public",
      createdBy: "u1",
    });
    expect(await listInheritedShares(ws2.id, "a/b.md")).toEqual([]);

    // Revoked ancestor shares drop out.
    await revokeShare(ws.id, inner.id);
    expect((await listInheritedShares(ws.id, "a/b/c.md")).map((s) => s.id)).toEqual([outer.id]);
  });

  it("revokeShare is workspace-scoped", async () => {
    const wsA = await freshWorkspace();
    const wsB = await freshWorkspace();
    const s = await createShare({
      workspaceId: wsA.id,
      path: "x.md",
      kind: "file",
      access: "public",
      createdBy: "u1",
    });
    // A different workspace cannot revoke A's share.
    expect(await revokeShare(wsB.id, s.id)).toBe(false);
    expect((await listShares(wsA.id, "x.md")).length).toBe(1);
  });
});