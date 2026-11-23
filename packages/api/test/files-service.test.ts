import { createHash, randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { conflictedCopyName } from "shared";
import { NO_GRANTS, asMember } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

// Local fs storage; never R2 (see useTempBlobDir).
const BLOB_DIR = useTempBlobDir("treehouse-files-");

// Run the WHOLE file-service suite with encryption at rest switched on. The
// version CAS, conflicted copies, resurrection, restore, and quota accounting
// are what "encryption is invisible to callers" actually has to mean, so they
// are worth far more as coverage than a handful of bespoke encryption tests.
process.env.BLOB_KEK = `v1:${randomBytes(32).toString("base64")}`;

const { usePrismaClient } = await import("db");
const { useFileService, PathError, normalizePath, maxFileBytes } =
  await import("../server/utils/files");
const { getNodeAcl, setNodePrivate } = await import("../server/utils/acl");

const db = usePrismaClient();
const svc = useFileService();
const NOW = "2026-06-06T00:00:00Z";

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);

describe("file service", () => {
  it("creates, reads, and records an attributed change event", async () => {
    const ws = await freshWorkspace();
    const res = await svc.write({
      workspaceId: ws.id,
      path: "notes.md",
      body: enc("hello"),
      actor: { principal: "agent", actorId: "u1", access: asMember("u1") },
      nowIso: NOW,
    });
    expect(res).toMatchObject({ ok: true, version: 1 });

    const read = await svc.read(ws.id, "notes.md", "trusted");
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(dec(read.body)).toBe("hello");
      expect(read.contentType).toBe("text/markdown");
    }

    // AE2: attribution comes from the passed principal (sourced from the key).
    const events = await db.changeEvent.findMany({ where: { workspaceId: ws.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: "write", principal: "agent", path: "notes.md" });
  });

  it("AE1: a stale write keeps both copies, loses nothing", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "p.md",
      body: enc("original"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });

    // Writer A advances v1 -> v2
    const a = await svc.write({
      workspaceId: ws.id,
      path: "p.md",
      body: enc("A-edit"),
      baseVersion: 1,
      actor: { principal: "agent", access: NO_GRANTS },
      nowIso: NOW,
    });
    expect(a).toMatchObject({ ok: true, version: 2 });

    // Writer B writes against the now-stale base v1
    const b = await svc.write({
      workspaceId: ws.id,
      path: "p.md",
      body: enc("B-edit"),
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    expect(b.ok).toBe(false);
    expect(b.conflict?.currentVersion).toBe(2);
    const copyPath = b.conflict?.conflictCopyPath as string;
    expect(copyPath).toContain("conflicted copy");

    // Winner keeps A's bytes; B's bytes survive in the conflicted copy.
    expect(dec(((await svc.read(ws.id, "p.md", "trusted")) as { body: Uint8Array }).body)).toBe(
      "A-edit",
    );
    expect(dec(((await svc.read(ws.id, copyPath, "trusted")) as { body: Uint8Array }).body)).toBe(
      "B-edit",
    );
  });

  // A stale write can reach the server more than once — the burst that prompted
  // this came from one folder being supervised by several sync engines at once,
  // each answering the same filesystem event. Every arrival used to mint its own
  // timestamped copy, so one losing state left six byte-identical files to hash
  // and reconcile by hand. Bytes already preserved stay preserved; don't repeat
  // them.
  it("replaying identical losing bytes reuses the conflicted copy", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "note.md",
      body: enc("v1"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    await svc.write({
      workspaceId: ws.id,
      path: "note.md",
      body: enc("v2-winner"),
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });

    let stamp = 0;
    const stale = () =>
      svc.write({
        workspaceId: ws.id,
        path: "note.md",
        body: enc("the-losing-state"),
        baseVersion: 1,
        actor: { principal: "human", access: NO_GRANTS },
        // Distinct stamps: replays land milliseconds apart, so equal names are
        // not what collapses them — equal CONTENT is.
        nowIso: new Date(Date.parse(NOW) + ++stamp).toISOString(),
      });

    const first = await stale();
    const replays = await Promise.all([stale(), stale(), stale(), stale()]);
    const copies = new Set(
      [first, ...replays].map((r) => {
        expect(r.ok).toBe(false);
        return r.conflict?.conflictCopyPath as string;
      }),
    );
    expect(copies.size).toBe(1);

    const all = await svc.list(ws.id, "", "trusted");
    expect(all.filter((e) => e.path.includes("conflicted copy"))).toHaveLength(1);
    // The losing bytes are still preserved, and the winner is untouched.
    expect(
      dec(((await svc.read(ws.id, [...copies][0], "trusted")) as { body: Uint8Array }).body),
    ).toBe("the-losing-state");
    expect(dec(((await svc.read(ws.id, "note.md", "trusted")) as { body: Uint8Array }).body)).toBe(
      "v2-winner",
    );
  });

  // An extension-less path's bounds are open-ended (there is no suffix to pin
  // them), so "note"'s copies and "note.md"'s copies share a prefix. Identical
  // bytes across the two must NOT be deduplicated into one file.
  it("does not mistake a copy of a different file for a replay", async () => {
    const ws = await freshWorkspace();
    const setup = async (p: string) => {
      await svc.write({
        workspaceId: ws.id,
        path: p,
        body: enc("v1"),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      await svc.write({
        workspaceId: ws.id,
        path: p,
        body: enc("winner"),
        baseVersion: 1,
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      return svc.write({
        workspaceId: ws.id,
        path: p,
        body: enc("same-losing-bytes"),
        baseVersion: 1,
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
    };
    const withExt = await setup("note.md");
    const withoutExt = await setup("note");
    expect(withExt.conflict?.conflictCopyPath).not.toBe(withoutExt.conflict?.conflictCopyPath);
    expect(withExt.conflict?.conflictCopyPath).toMatch(/\.md$/);
    expect(withoutExt.conflict?.conflictCopyPath).not.toMatch(/\.md$/);
  });

  // The twin lookup filters candidates in JS, so it must page rather than cap:
  // an extension-less path's bounds admit every SIBLING family's copies
  // ("note"'s bounds match "note (conflicted copy — …).md"), and enough of those
  // sharing the losing content would fill a fixed page and hide the real copy —
  // minting the duplicate this whole path exists to prevent.
  it("finds a twin sitting past the first page of same-hash siblings", async () => {
    const ws = await freshWorkspace();
    const losing = "the-losing-state";
    // 60 copies of the NEIGHBOURING file "note.md" holding the losing bytes.
    // They match "note"'s broad bounds, sort first, and are not copies of it.
    for (let i = 0; i < 60; i++) {
      await svc.write({
        workspaceId: ws.id,
        path: `note (conflicted copy — human — 2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z).md`,
        body: enc(losing),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
    }
    // The real copy of "note", sorting AFTER all of them.
    const twin = "note (conflicted copy — human — 2026-12-31T00:00:00.000Z)";
    await svc.write({
      workspaceId: ws.id,
      path: twin,
      body: enc(losing),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });

    await svc.write({
      workspaceId: ws.id,
      path: "note",
      body: enc("v1"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    await svc.write({
      workspaceId: ws.id,
      path: "note",
      body: enc("winner"),
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    const stale = await svc.write({
      workspaceId: ws.id,
      path: "note",
      body: enc(losing),
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });

    expect(stale.ok).toBe(false);
    expect(stale.conflict?.conflictCopyPath).toBe(twin);
  });

  it("a DIFFERENT losing state still gets its own conflicted copy", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "note.md",
      body: enc("v1"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    await svc.write({
      workspaceId: ws.id,
      path: "note.md",
      body: enc("v2-winner"),
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    const one = await svc.write({
      workspaceId: ws.id,
      path: "note.md",
      body: enc("loser-A"),
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    const two = await svc.write({
      workspaceId: ws.id,
      path: "note.md",
      body: enc("loser-B"),
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: new Date(Date.parse(NOW) + 5000).toISOString(),
    });
    expect(one.conflict?.conflictCopyPath).not.toBe(two.conflict?.conflictCopyPath);
    const all = await svc.list(ws.id, "", "trusted");
    expect(all.filter((e) => e.path.includes("conflicted copy"))).toHaveLength(2);
  });

  it("create-on-existing-path produces a conflicted copy (no overwrite)", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "x.md",
      body: enc("first"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    const res = await svc.write({
      workspaceId: ws.id,
      path: "x.md",
      body: enc("second"),
      actor: { principal: "agent", access: NO_GRANTS },
      nowIso: NOW,
    });
    expect(res.ok).toBe(false);
    expect(dec(((await svc.read(ws.id, "x.md", "trusted")) as { body: Uint8Array }).body)).toBe(
      "first",
    );
  });

  it("read of an unknown path is not_found", async () => {
    const ws = await freshWorkspace();
    expect((await svc.read(ws.id, "nope.md", "trusted")).status).toBe("not_found");
  });

  it("delete: clean delete works; a stale delete loses to a concurrent edit", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "d.md",
      body: enc("v1"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    // edit to v2
    await svc.write({
      workspaceId: ws.id,
      path: "d.md",
      body: enc("v2"),
      baseVersion: 1,
      actor: { principal: "agent", access: NO_GRANTS },
      nowIso: NOW,
    });
    // stale delete against v1 -> conflict (resurrection over loss), file remains
    const stale = await svc.remove({
      workspaceId: ws.id,
      path: "d.md",
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
    });
    expect(stale.status).toBe("conflict");
    expect((await svc.read(ws.id, "d.md", "trusted")).status).toBe("ok");
    // correct delete against v2 succeeds
    const ok = await svc.remove({
      workspaceId: ws.id,
      path: "d.md",
      baseVersion: 2,
      actor: { principal: "human", access: NO_GRANTS },
    });
    expect(ok.status).toBe("ok");
    expect((await svc.read(ws.id, "d.md", "trusted")).status).toBe("not_found");
  });

  it("move: source gone, dest present; dest collision rejected", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "a.md",
      body: enc("body"),
      actor: { principal: "agent", access: NO_GRANTS },
      nowIso: NOW,
    });
    const moved = await svc.move({
      workspaceId: ws.id,
      from: "a.md",
      to: "b.md",
      actor: { principal: "agent", access: NO_GRANTS },
    });
    expect(moved.status).toBe("ok");
    expect((await svc.read(ws.id, "a.md", "trusted")).status).toBe("not_found");
    expect((await svc.read(ws.id, "b.md", "trusted")).status).toBe("ok");

    await svc.write({
      workspaceId: ws.id,
      path: "c.md",
      body: enc("c"),
      actor: { principal: "agent", access: NO_GRANTS },
      nowIso: NOW,
    });
    const collide = await svc.move({
      workspaceId: ws.id,
      from: "b.md",
      to: "c.md",
      actor: { principal: "agent", access: NO_GRANTS },
    });
    expect(collide.status).toBe("dest_exists");
  });

  it("rejects path traversal", () => {
    expect(() => normalizePath("../escape")).toThrow(PathError);
    expect(() => normalizePath("a/../../b")).toThrow(PathError);
    expect(() => normalizePath("..\\..\\escape")).toThrow(PathError); // Windows separator
    expect(() => normalizePath("a\\b")).toThrow(PathError);
    expect(normalizePath("a//b/./c.md")).toBe("a/b/c.md");
  });

  it("lists entries under a prefix", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "dir/one.md",
      body: enc("1"),
      actor: { principal: "agent", access: NO_GRANTS },
      nowIso: NOW,
    });
    await svc.write({
      workspaceId: ws.id,
      path: "dir/two.md",
      body: enc("2"),
      actor: { principal: "agent", access: NO_GRANTS },
      nowIso: NOW,
    });
    await svc.write({
      workspaceId: ws.id,
      path: "other.md",
      body: enc("3"),
      actor: { principal: "agent", access: NO_GRANTS },
      nowIso: NOW,
    });
    const entries = await svc.list(ws.id, "dir", "trusted");
    expect(entries.map((e) => e.path).sort()).toEqual(["dir/one.md", "dir/two.md"]);
  });

  it("records agent key id + label and a content pointer on writes (U2)", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "k.md",
      body: enc("hello"),
      actor: {
        principal: "agent",
        actorId: "owner-1",
        actorKeyId: "key-1",
        actorLabel: "Claude Code",
        access: asMember("owner-1"),
      },
      nowIso: NOW,
    });
    const sha = createHash("sha256").update(enc("hello")).digest("hex");
    const ev = await db.changeEvent.findFirst({ where: { workspaceId: ws.id, path: "k.md" } });
    expect(ev).toMatchObject({
      op: "write",
      principal: "agent",
      actorId: "owner-1",
      actorKeyId: "key-1",
      actorLabel: "Claude Code",
      contentHash: sha,
    });
  });

  it("leaves key fields null for cookie/human-direct writes (U2)", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "c.md",
      body: enc("x"),
      actor: { principal: "human", actorId: "user-1", access: asMember("user-1") },
      nowIso: NOW,
    });
    const ev = await db.changeEvent.findFirst({ where: { workspaceId: ws.id, path: "c.md" } });
    expect(ev?.actorKeyId).toBeNull();
    expect(ev?.actorLabel).toBeNull();
  });

  it("records a non-null key id for a human-actorType CLI key (U2/KTD3)", async () => {
    // A human using a CLI key: principal stays human, but a key id is present.
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "h.md",
      body: enc("x"),
      actor: {
        principal: "human",
        actorId: "user-1",
        actorKeyId: "human-key",
        actorLabel: "my-cli",
        access: asMember("user-1"),
      },
      nowIso: NOW,
    });
    const ev = await db.changeEvent.findFirst({ where: { workspaceId: ws.id, path: "h.md" } });
    expect(ev).toMatchObject({ principal: "human", actorKeyId: "human-key" });
  });

  it("AE3: restore writes a prior version's bytes as a new head version (U3)", async () => {
    const ws = await freshWorkspace();
    const seq = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < seq.length; i++) {
      await svc.write({
        workspaceId: ws.id,
        path: "r.md",
        body: enc(seq[i] as string),
        baseVersion: i === 0 ? undefined : i,
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
    }
    const res = await svc.restore({
      workspaceId: ws.id,
      path: "r.md",
      targetVersion: 3,
      actor: { principal: "human", actorId: "user-1", access: asMember("user-1") },
      nowIso: NOW,
    });
    expect(res).toMatchObject({ status: "ok", version: 6, restoredFrom: 3 });
    expect(dec(((await svc.read(ws.id, "r.md", "trusted")) as { body: Uint8Array }).body)).toBe(
      "c",
    );
    const restoreEv = await db.changeEvent.findFirst({
      where: { workspaceId: ws.id, path: "r.md", op: "restore" },
    });
    expect(restoreEv).toMatchObject({ version: 6, actorId: "user-1" });
  });

  it("AE4: restore lands on top of the current version, not the opened one (U3/R9)", async () => {
    const ws = await freshWorkspace();
    for (let i = 0; i < 5; i++) {
      await svc.write({
        workspaceId: ws.id,
        path: "t.md",
        body: enc(`v${i + 1}`),
        baseVersion: i === 0 ? undefined : i,
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
    }
    // The file advances to v6 after the panel "opened" at v5.
    await svc.write({
      workspaceId: ws.id,
      path: "t.md",
      body: enc("v6"),
      baseVersion: 5,
      actor: { principal: "agent", access: NO_GRANTS },
      nowIso: NOW,
    });
    const res = await svc.restore({
      workspaceId: ws.id,
      path: "t.md",
      targetVersion: 3,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    expect(res).toMatchObject({ status: "ok", version: 7 });
    expect(dec(((await svc.read(ws.id, "t.md", "trusted")) as { body: Uint8Array }).body)).toBe(
      "v3",
    );
  });

  it("AE6: restores binary bytes with no text handling (U3)", async () => {
    const ws = await freshWorkspace();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    await svc.write({
      workspaceId: ws.id,
      path: "i.png",
      body: png,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    await svc.write({
      workspaceId: ws.id,
      path: "i.png",
      body: new Uint8Array([0x01, 0x02]),
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    const res = await svc.restore({
      workspaceId: ws.id,
      path: "i.png",
      targetVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    expect(res.status).toBe("ok");
    const read = (await svc.read(ws.id, "i.png", "trusted")) as { body: Uint8Array };
    expect(Array.from(read.body)).toEqual(Array.from(png));
  });

  it("readVersion/restore of a reused version resolves the current incarnation (U3/KTD1)", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "z.md",
      body: enc("old-v1"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    await svc.remove({
      workspaceId: ws.id,
      path: "z.md",
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
    });
    await svc.write({
      workspaceId: ws.id,
      path: "z.md",
      body: enc("new-v1"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    const rv = await svc.readVersion({
      viewer: "trusted",
      workspaceId: ws.id,
      path: "z.md",
      version: 1,
    });
    expect(rv.status).toBe("ok");
    if (rv.status === "ok") expect(dec(rv.body)).toBe("new-v1");
    const res = await svc.restore({
      workspaceId: ws.id,
      path: "z.md",
      targetVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    expect(res).toMatchObject({ status: "ok", version: 2 });
    expect(dec(((await svc.read(ws.id, "z.md", "trusted")) as { body: Uint8Array }).body)).toBe(
      "new-v1",
    );
  });

  it("a version produced by a move is viewable and restorable (U3)", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "mv1.md",
      body: enc("moved-bytes"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    await svc.move({
      workspaceId: ws.id,
      from: "mv1.md",
      to: "mv2.md",
      actor: { principal: "human", access: NO_GRANTS },
    });
    const rv = await svc.readVersion({
      viewer: "trusted",
      workspaceId: ws.id,
      path: "mv2.md",
      version: 1,
    });
    expect(rv.status).toBe("ok");
    if (rv.status === "ok") expect(dec(rv.body)).toBe("moved-bytes");
  });

  it("readVersion: not_found for unknown path, version_not_found for pre-pointer events (U3/R8)", async () => {
    const ws = await freshWorkspace();
    expect(
      (
        await svc.readVersion({
          viewer: "trusted",
          workspaceId: ws.id,
          path: "ghost.md",
          version: 1,
        })
      ).status,
    ).toBe("not_found");
    // Simulate a pre-feature event: a write-op row with no content pointer.
    await db.changeEvent.create({
      data: { workspaceId: ws.id, path: "legacy.md", op: "write", version: 1, principal: "human" },
    });
    expect(
      (
        await svc.readVersion({
          viewer: "trusted",
          workspaceId: ws.id,
          path: "legacy.md",
          version: 1,
        })
      ).status,
    ).toBe("version_not_found");
  });

  it("restore of an unknown path is not_found (U3)", async () => {
    const ws = await freshWorkspace();
    const res = await svc.restore({
      workspaceId: ws.id,
      path: "nope.md",
      targetVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    expect(res.status).toBe("not_found");
  });

  it("move records the source content hash on the destination event, null on delete (U2)", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "m1.md",
      body: enc("body"),
      actor: { principal: "agent", access: NO_GRANTS },
      nowIso: NOW,
    });
    const sha = createHash("sha256").update(enc("body")).digest("hex");
    await svc.move({
      workspaceId: ws.id,
      from: "m1.md",
      to: "m2.md",
      actor: { principal: "agent", access: NO_GRANTS },
    });
    const moveEv = await db.changeEvent.findFirst({
      where: { workspaceId: ws.id, path: "m2.md", op: "move" },
    });
    const delEv = await db.changeEvent.findFirst({
      where: { workspaceId: ws.id, path: "m1.md", op: "delete" },
    });
    expect(moveEv?.contentHash).toBe(sha);
    expect(delEv?.contentHash).toBeNull();
  });
});

// Run `fn` with a workspace storage limit set, restoring the unlimited default
// afterward (quotaForWorkspace reads the env at call time).
async function withLimit<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
  process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = String(bytes);
  try {
    return await fn();
  } finally {
    delete process.env.DEFAULT_WORKSPACE_QUOTA_BYTES;
  }
}

describe("storage usage and limits", () => {
  it("usage sums live file sizes, treats empty as 0, and honors excludePath", async () => {
    const ws = await freshWorkspace();
    expect(await svc.usage(ws.id)).toBe(0);
    await svc.write({
      workspaceId: ws.id,
      path: "a.txt",
      body: enc("12345"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    await svc.write({
      workspaceId: ws.id,
      path: "b.txt",
      body: enc("123"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    expect(await svc.usage(ws.id)).toBe(8);
    expect(await svc.usage(ws.id, { excludePath: "a.txt" })).toBe(3);
    await svc.remove({
      workspaceId: ws.id,
      path: "a.txt",
      baseVersion: 1,
      actor: { principal: "human", access: NO_GRANTS },
    });
    expect(await svc.usage(ws.id)).toBe(3);
  });

  it("does not enforce when unlimited (the default)", async () => {
    const ws = await freshWorkspace();
    const res = await svc.write({
      workspaceId: ws.id,
      path: "big.txt",
      body: enc("x".repeat(10_000)),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    expect(res).toMatchObject({ ok: true, version: 1 });
  });

  it("rejects a create that would exceed the limit and persists no row", async () => {
    const ws = await freshWorkspace();
    await withLimit(10, async () => {
      await svc.write({
        workspaceId: ws.id,
        path: "a.txt",
        body: enc("12345"),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      const res = await svc.write({
        workspaceId: ws.id,
        path: "b.txt",
        body: enc("12345678"),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      expect(res.ok).toBe(false);
      expect(res.quotaExceeded).toBe(true);
      expect(res.usage).toMatchObject({ usedBytes: 5, limitBytes: 10 });
      expect(await svc.stat(ws.id, "b.txt", "trusted")).toBeNull();
      expect(await svc.usage(ws.id)).toBe(5);
    });
  });

  it("rejects a matched-version update over the limit, leaving the version unchanged", async () => {
    const ws = await freshWorkspace();
    await withLimit(10, async () => {
      await svc.write({
        workspaceId: ws.id,
        path: "a.txt",
        body: enc("12345"),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      const res = await svc.write({
        workspaceId: ws.id,
        path: "a.txt",
        body: enc("x".repeat(20)),
        baseVersion: 1,
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      expect(res.quotaExceeded).toBe(true);
      expect((await svc.stat(ws.id, "a.txt", "trusted"))?.version).toBe(1);
      expect(dec(((await svc.read(ws.id, "a.txt", "trusted")) as { body: Uint8Array }).body)).toBe(
        "12345",
      );
    });
  });

  it("allows a shrinking update at the limit", async () => {
    const ws = await freshWorkspace();
    await withLimit(10, async () => {
      await svc.write({
        workspaceId: ws.id,
        path: "a.txt",
        body: enc("1234567890"),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      const res = await svc.write({
        workspaceId: ws.id,
        path: "a.txt",
        body: enc("12"),
        baseVersion: 1,
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      expect(res).toMatchObject({ ok: true, version: 2 });
    });
  });

  it("over-limit recovery: a delete frees space and unblocks the next write", async () => {
    const ws = await freshWorkspace();
    await withLimit(10, async () => {
      await svc.write({
        workspaceId: ws.id,
        path: "a.txt",
        body: enc("1234567890"),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      const blocked = await svc.write({
        workspaceId: ws.id,
        path: "b.txt",
        body: enc("1"),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      expect(blocked.quotaExceeded).toBe(true);
      await svc.remove({
        workspaceId: ws.id,
        path: "a.txt",
        baseVersion: 1,
        actor: { principal: "human", access: NO_GRANTS },
      });
      const okWrite = await svc.write({
        workspaceId: ws.id,
        path: "b.txt",
        body: enc("1"),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      expect(okWrite).toMatchObject({ ok: true, version: 1 });
    });
  });

  it("AE4 / R10: a stale write keeps a conflicted copy over the limit; the next clean write is blocked", async () => {
    const ws = await freshWorkspace();
    await withLimit(10, async () => {
      await svc.write({
        workspaceId: ws.id,
        path: "p.md",
        body: enc("1234567890"),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      // Advance v1 -> v2 (same size, matched version): within limit.
      const a = await svc.write({
        workspaceId: ws.id,
        path: "p.md",
        body: enc("ABCDEFGHIJ"),
        baseVersion: 1,
        actor: { principal: "agent", access: NO_GRANTS },
        nowIso: NOW,
      });
      expect(a).toMatchObject({ ok: true, version: 2 });
      // Stale write against v1 -> conflicted copy, ALLOWED to exceed the limit.
      const stale = await svc.write({
        workspaceId: ws.id,
        path: "p.md",
        body: enc("ZZZZZZZZZZ"),
        baseVersion: 1,
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      expect(stale.ok).toBe(false);
      expect(stale.quotaExceeded).toBeUndefined();
      expect(stale.conflict?.conflictCopyPath).toContain("conflicted copy");
      expect(await svc.usage(ws.id)).toBe(20);
      // Now over the limit: a fresh clean write is rejected.
      const blocked = await svc.write({
        workspaceId: ws.id,
        path: "new.md",
        body: enc("1"),
        actor: { principal: "human", access: NO_GRANTS },
        nowIso: NOW,
      });
      expect(blocked.quotaExceeded).toBe(true);
    });
  });
});
describe("private-directory access enforcement (U3)", () => {
  const OWNER = "user-owner";
  const OTHER = "user-other";

  async function wsWithPrivateFolder() {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "journal/today.md",
      body: enc("secret"),
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    await setNodePrivate({ workspaceId: ws.id, path: "journal", kind: "folder", ownerId: OWNER });
    return ws;
  }

  it("non-owner read/stat/readVersion of a private path resolve to not_found/null", async () => {
    const ws = await wsWithPrivateFolder();
    expect((await svc.read(ws.id, "journal/today.md", asMember(OTHER))).status).toBe("not_found");
    expect(await svc.stat(ws.id, "journal/today.md", asMember(OTHER))).toBeNull();
    expect(
      (
        await svc.readVersion({
          workspaceId: ws.id,
          path: "journal/today.md",
          version: 1,
          viewer: asMember(OTHER),
        })
      ).status,
    ).toBe("not_found");
    // The owner still reads it.
    expect((await svc.read(ws.id, "journal/today.md", asMember(OWNER))).status).toBe("ok");
    // An internal/trusted call (no actorId) bypasses enforcement.
    expect((await svc.read(ws.id, "journal/today.md", "trusted")).status).toBe("ok");
  });

  it("non-owner write to a private path is forbidden; owner succeeds", async () => {
    const ws = await wsWithPrivateFolder();
    const denied = await svc.write({
      workspaceId: ws.id,
      path: "journal/today.md",
      body: enc("hijack"),
      baseVersion: 1,
      actor: { principal: "human", actorId: OTHER, access: asMember(OTHER) },
      nowIso: NOW,
    });
    expect(denied.forbidden).toBe(true);
    // A non-owner cannot create a new file under the private folder either.
    const deniedCreate = await svc.write({
      workspaceId: ws.id,
      path: "journal/new.md",
      body: enc("x"),
      actor: { principal: "human", actorId: OTHER, access: asMember(OTHER) },
      nowIso: NOW,
    });
    expect(deniedCreate.forbidden).toBe(true);
    const ok = await svc.write({
      workspaceId: ws.id,
      path: "journal/today.md",
      body: enc("owner-edit"),
      baseVersion: 1,
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    expect(ok.ok).toBe(true);
  });

  it("non-owner remove/move/restore of a private path resolve to not_found", async () => {
    const ws = await wsWithPrivateFolder();
    expect(
      (
        await svc.remove({
          workspaceId: ws.id,
          path: "journal/today.md",
          baseVersion: 1,
          actor: { principal: "human", actorId: OTHER, access: asMember(OTHER) },
        })
      ).status,
    ).toBe("not_found");
    expect(
      (
        await svc.move({
          workspaceId: ws.id,
          from: "journal/today.md",
          to: "stolen.md",
          actor: { principal: "human", actorId: OTHER, access: asMember(OTHER) },
        })
      ).status,
    ).toBe("not_found");
    expect(
      (
        await svc.restore({
          workspaceId: ws.id,
          path: "journal/today.md",
          targetVersion: 1,
          actor: { principal: "human", actorId: OTHER, access: asMember(OTHER) },
          nowIso: NOW,
        })
      ).status,
    ).toBe("not_found");
  });

  it("owner promoting a private file out makes it readable by others (R11)", async () => {
    const ws = await wsWithPrivateFolder();
    const moved = await svc.move({
      workspaceId: ws.id,
      from: "journal/today.md",
      to: "shared/today.md",
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
    });
    expect(moved.status).toBe("ok");
    expect((await svc.read(ws.id, "shared/today.md", asMember(OTHER))).status).toBe("ok");
  });

  it("a conflicted copy of a private file inherits the owner's access (KTD5)", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "diary.md",
      body: enc("v1"),
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    // File-level private ACL (the case a sibling conflict copy wouldn't inherit by path).
    await setNodePrivate({ workspaceId: ws.id, path: "diary.md", kind: "file", ownerId: OWNER });
    // Owner makes a stale write → a conflicted copy is created.
    const res = await svc.write({
      workspaceId: ws.id,
      path: "diary.md",
      body: enc("v2-stale"),
      baseVersion: 99,
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    expect(res.ok).toBe(false);
    const copyPath = res.conflict?.conflictCopyPath as string;
    expect(copyPath).toBeTruthy();
    // The copy is private to the owner — invisible to others.
    expect((await svc.read(ws.id, copyPath, asMember(OTHER))).status).toBe("not_found");
    expect((await svc.read(ws.id, copyPath, asMember(OWNER))).status).toBe("ok");
  });

  it("a conflicted copy stays in its folder, even one with a dot in its name", async () => {
    const ws = await freshWorkspace();
    const path = "client.v1/README";
    await svc.write({
      workspaceId: ws.id,
      path,
      body: enc("v1"),
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    await setNodePrivate({ workspaceId: ws.id, path: "client.v1", kind: "folder", ownerId: OWNER });
    const res = await svc.write({
      workspaceId: ws.id,
      path,
      body: enc("stale"),
      baseVersion: 99,
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    const copyPath = res.conflict?.conflictCopyPath as string;
    expect(copyPath.startsWith("client.v1/")).toBe(true);
    expect((await svc.read(ws.id, copyPath, asMember(OTHER))).status).toBe("not_found");
  });

  it("a conflicted copy of a file restricted as a folder is restricted too", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "diary",
      body: enc("v1"),
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    // The default kind for set_private, which an agent can leave on a file.
    await setNodePrivate({ workspaceId: ws.id, path: "diary", kind: "folder", ownerId: OWNER });
    const res = await svc.write({
      workspaceId: ws.id,
      path: "diary",
      body: enc("stale"),
      baseVersion: 99,
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    const copyPath = res.conflict?.conflictCopyPath as string;
    expect((await svc.read(ws.id, copyPath, asMember(OTHER))).status).toBe("not_found");
    expect((await svc.read(ws.id, copyPath, asMember(OWNER))).status).toBe("ok");
  });

  it("a conflicted copy never takes over a restriction left at its name", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "diary.md",
      body: enc("v1"),
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    await setNodePrivate({ workspaceId: ws.id, path: "diary.md", kind: "file", ownerId: OWNER });
    // Someone else's private file once lived at the name the copy would take:
    // the file has gone, but its restriction stays, so the path stays theirs.
    const taken = conflictedCopyName("diary.md", "human", NOW, 1);
    await setNodePrivate({ workspaceId: ws.id, path: taken, kind: "file", ownerId: OTHER });

    const res = await svc.write({
      workspaceId: ws.id,
      path: "diary.md",
      body: enc("v2-stale"),
      baseVersion: 99,
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });

    const copyPath = res.conflict?.conflictCopyPath as string;
    expect(copyPath).toBe(conflictedCopyName("diary.md", "human", NOW, 2));
    expect((await getNodeAcl(ws.id, taken))?.grants).toEqual([
      { subject: "user", userId: OTHER, level: "write" },
    ]);
    expect((await svc.read(ws.id, copyPath, asMember(OWNER))).status).toBe("ok");
    expect((await svc.read(ws.id, copyPath, asMember(OTHER))).status).toBe("not_found");
  });

  it("an explicit file ACL follows the file across a move (R10)", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "a.md",
      body: enc("x"),
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    await setNodePrivate({ workspaceId: ws.id, path: "a.md", kind: "file", ownerId: OWNER });
    await svc.move({
      workspaceId: ws.id,
      from: "a.md",
      to: "b.md",
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
    });
    // The ACL moved with the file: b.md is private, a.md no longer governed.
    expect((await svc.read(ws.id, "b.md", asMember(OTHER))).status).toBe("not_found");
    expect((await svc.read(ws.id, "b.md", asMember(OWNER))).status).toBe("ok");
  });
});
describe("list visibility filtering (U6)", () => {
  const OWNER = "user-owner";
  const OTHER = "user-other";

  it("omits a private node for non-owners, keeps it for the owner and trusted callers", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "journal/today.md",
      body: enc("secret"),
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    await svc.write({
      workspaceId: ws.id,
      path: "public.md",
      body: enc("shared"),
      actor: { principal: "human", actorId: OWNER, access: asMember(OWNER) },
      nowIso: NOW,
    });
    await setNodePrivate({ workspaceId: ws.id, path: "journal", kind: "folder", ownerId: OWNER });

    const ownerPaths = (await svc.list(ws.id, "", asMember(OWNER))).map((e) => e.path);
    expect(ownerPaths).toContain("journal/today.md");
    expect(ownerPaths).toContain("public.md");

    const otherPaths = (await svc.list(ws.id, "", asMember(OTHER))).map((e) => e.path);
    expect(otherPaths).not.toContain("journal/today.md");
    expect(otherPaths).toContain("public.md");

    const trustedPaths = (await svc.list(ws.id, "", "trusted")).map((e) => e.path);
    expect(trustedPaths).toContain("journal/today.md");
  });
});

// MAX_FILE_BYTES parsing (U2). Pure env-config behavior — no database needed.
describe("maxFileBytes() config parsing", () => {
  const DEFAULT = 100 * 1024 * 1024;
  const INT_CEILING = 2_147_483_647;
  const original = process.env.MAX_FILE_BYTES;

  const withEnv = (value: string | undefined): number => {
    if (value === undefined) delete process.env.MAX_FILE_BYTES;
    else process.env.MAX_FILE_BYTES = value;
    try {
      return maxFileBytes();
    } finally {
      if (original === undefined) delete process.env.MAX_FILE_BYTES;
      else process.env.MAX_FILE_BYTES = original;
    }
  };

  it("uses the default when unset, blank, or malformed", () => {
    expect(withEnv(undefined)).toBe(DEFAULT);
    expect(withEnv("")).toBe(DEFAULT);
    expect(withEnv("100MB")).toBe(DEFAULT); // parseInt would give 100 bytes
    expect(withEnv("-1")).toBe(DEFAULT);
    expect(withEnv("0")).toBe(DEFAULT);
  });

  it("honours a valid override", () => {
    expect(withEnv("1024")).toBe(1024);
    expect(withEnv(" 2048 ")).toBe(2048);
  });

  it("clamps an override above the FileNode.size Int ceiling", () => {
    // Without the clamp, the guard would pass a body Postgres can't store, and
    // the write would die on an out-of-range metadata insert instead of a 413.
    expect(withEnv(String(INT_CEILING))).toBe(INT_CEILING);
    expect(withEnv(String(INT_CEILING + 1))).toBe(INT_CEILING);
    expect(withEnv("9999999999999")).toBe(INT_CEILING);
  });
});
describe("encryption at rest is actually engaged", () => {
  // Guard for the whole suite above: every test in this file runs with a KEK
  // set, so if encryption silently failed to engage they would all still pass
  // — proving nothing. This asserts on the bytes that really hit the disk.
  it("writes ciphertext to the blob store while reads round-trip", async () => {
    const ws = await freshWorkspace();
    const secret = "correct-horse-battery-staple";
    const written = await svc.write({
      workspaceId: ws.id,
      path: "secret.md",
      body: new TextEncoder().encode(secret),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    expect(written.ok).toBe(true);

    const node = await db.fileNode.findUniqueOrThrow({
      where: { workspaceId_path: { workspaceId: ws.id, path: "secret.md" } },
    });
    const onDisk = await readFile(join(BLOB_DIR, node.blobKey));
    expect(onDisk.includes(secret)).toBe(false);
    // "THE\0" — the format marker, proving this went through the encrypter.
    expect(onDisk.subarray(0, 4)).toEqual(Buffer.from([0x54, 0x48, 0x45, 0x00]));

    const read = await svc.read(ws.id, "secret.md", "trusted");
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(new TextDecoder().decode(read.body)).toBe(secret);
  });
});
describe("a corrupted blob is an integrity failure, not a missing one", () => {
  // The distinction is load-bearing. `blob_missing` is a benign lifecycle
  // outcome — routes map it to 502, and a pinned share link maps it to a
  // reassuring 410 ("this version is no longer available"). Reporting tampering
  // that way would hide an attack inside ordinary data loss, so every read path
  // must fail loudly instead.
  async function writeThenCorrupt(path: string) {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path,
      body: enc("intact contents"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    const node = await db.fileNode.findUniqueOrThrow({
      where: { workspaceId_path: { workspaceId: ws.id, path } },
    });
    const blobPath = join(BLOB_DIR, node.blobKey);
    const bytes = await readFile(blobPath);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
    await writeFile(blobPath, bytes);
    return { ws, node };
  }

  it("read() raises rather than reporting blob_missing", async () => {
    const { ws } = await writeThenCorrupt("tampered.md");
    await expect(svc.read(ws.id, "tampered.md", "trusted")).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("readByHash() raises rather than reporting blob_missing", async () => {
    // This is the path a pinned share permalink uses, where blob_missing
    // becomes a 410.
    const { ws, node } = await writeThenCorrupt("pinned.md");
    await expect(svc.readByHash(ws.id, node.contentHash)).rejects.toThrow(/failed authentication/);
  });

  it("readVersion() raises rather than reporting blob_missing", async () => {
    const { ws } = await writeThenCorrupt("versioned.md");
    await expect(
      svc.readVersion({ viewer: "trusted", workspaceId: ws.id, path: "versioned.md", version: 1 }),
    ).rejects.toThrow(/failed authentication/);
  });

  it("a genuinely absent blob still reports blob_missing (no regression)", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "gone.md",
      body: enc("bytes"),
      actor: { principal: "human", access: NO_GRANTS },
      nowIso: NOW,
    });
    const node = await db.fileNode.findUniqueOrThrow({
      where: { workspaceId_path: { workspaceId: ws.id, path: "gone.md" } },
    });
    await rm(join(BLOB_DIR, node.blobKey), { force: true });

    expect((await svc.read(ws.id, "gone.md", "trusted")).status).toBe("blob_missing");
    expect((await svc.readByHash(ws.id, node.contentHash)).status).toBe("blob_missing");
  });
});

describe("file service, rewriting identical bytes", () => {
  // Under an encrypting store, like production.
  async function encryptedService() {
    const storage = await import("../server/utils/storage");
    const real = storage.useBlobStore();
    const raw = storage.resolveBlobStore({ BLOB_DIR } as NodeJS.ProcessEnv);
    const dek = new Uint8Array(randomBytes(32));
    storage.setStorageForTesting(
      storage.encryptingBlobStoreForTesting(raw, async () => ({ dek, generation: 1 })),
    );
    return { svc: useFileService(), raw, restore: () => storage.setStorageForTesting(real) };
  }
  it("repairs a blob damaged beyond its first chunk when the same bytes are written again", async () => {
    const { svc: s, raw, restore } = await encryptedService();
    try {
      const ws = await freshWorkspace();
      const bytes = new Uint8Array(randomBytes(3 * 1024 * 1024));
      const write = (baseVersion?: number) =>
        s.write({
          workspaceId: ws.id,
          path: "clip.bin",
          body: bytes,
          baseVersion,
          actor: { principal: "agent", access: NO_GRANTS },
          nowIso: NOW,
        });
      expect((await write()).ok).toBe(true);

      // Damage the third chunk on disk.
      const key = `${ws.id}/${createHash("sha256").update(bytes).digest("hex")}`;
      const stored = new Uint8Array((await raw.get(key))!.body);
      stored[52 + 2 * (1024 * 1024 + 16) + 10] ^= 0xff;
      await raw.put(key, stored, "application/octet-stream");

      expect((await write(1)).ok).toBe(true);
      const opened = await s.open(ws.id, "clip.bin", "trusted");
      expect(opened.status).toBe("ok");
      const { collect } = await import("blob-io/byte-stream");
      const back = await collect(
        (opened as { blob: { body: AsyncIterable<Uint8Array> } }).blob.body,
      );
      expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
    } finally {
      restore();
    }
  });

  it("serves a corrected content type when the same bytes are written with it", async () => {
    const { svc: s, restore } = await encryptedService();
    try {
      const ws = await freshWorkspace();
      const svg = enc(`<svg xmlns="http://www.w3.org/2000/svg" data-n="${Math.random()}"/>`);
      const write = (contentType: string, baseVersion?: number) =>
        s.write({
          workspaceId: ws.id,
          path: "logo.svg",
          body: svg,
          contentType,
          baseVersion,
          actor: { principal: "agent", access: NO_GRANTS },
          nowIso: NOW,
        });
      expect((await write("application/octet-stream")).ok).toBe(true);
      expect((await write("image/svg+xml", 1)).ok).toBe(true);
      const opened = await s.open(ws.id, "logo.svg", "trusted");
      expect(opened.status === "ok" && opened.blob.contentType).toBe("image/svg+xml");
    } finally {
      restore();
    }
  });
});