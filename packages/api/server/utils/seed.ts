import { useFileService } from "./files";
import { SEED_AGENTS, SEED_README } from "./seed-content";

// The starter kit written into a workspace at creation. README.md is the human's
// front page (the app renders it via the folder-default-page convention);
// AGENTS.md is the setup guide their agent follows. See seed-content.ts.
const KIT: { path: string; body: string }[] = [
  { path: "README.md", body: SEED_README },
  { path: "AGENTS.md", body: SEED_AGENTS },
];

/**
 * Write the starter kit into a newly created workspace.
 *
 * Idempotent: a path that already exists is skipped, never overwritten. This is
 * not just belt-and-braces — writing an existing path with `baseVersion:
 * undefined` goes down the file service's conflict path and lands a "conflicted
 * copy" beside it, which is exactly the confusing artefact a sync product must
 * not manufacture on its own.
 *
 * The stat-then-write is deliberately NOT atomic, which is safe only because of
 * WHERE this is called: every call site runs inside workspace creation, before
 * the new id has been handed to anyone, so there is no second writer to race
 * with. If you ever call this on a workspace that is already reachable — a
 * "reset this workspace" action, or a backfill over existing workspaces — that
 * assumption breaks and a concurrent write could produce a conflicted copy.
 * Add a create-if-absent primitive to the file service before doing that.
 *
 * Never throws. A seed is a convenience; the workspace is the product. Signing
 * up must not fail because the blob store was unreachable or the org was already
 * at its storage limit, so every failure is logged and swallowed. Do not
 * "fix" this into a throw.
 *
 * Set TREEHOUSE_SEED=0 to disable seeding entirely (self-hosters who don't want
 * opinionated content; tests that need a genuinely empty workspace).
 */
export async function seedWorkspace(workspaceId: string): Promise<void> {
  if (process.env.TREEHOUSE_SEED === "0") return;

  try {
    const svc = useFileService();
    const nowIso = new Date().toISOString();
    const body = new TextEncoder();

    for (const file of KIT) {
      if (await svc.stat(workspaceId, file.path, "trusted")) continue;
      const result = await svc.write({
        workspaceId,
        path: file.path,
        body: body.encode(file.body),
        contentType: "text/markdown",
        baseVersion: undefined,
        // There is no system principal — Actor.principal is "agent" | "human" —
        // and adding one is a ChangeEvent schema change this doesn't justify.
        // "agent" is the closer of the two; the label disambiguates it in the
        // change feed.
        actor: { principal: "agent", actorLabel: "Treehouse", access: "trusted" },
        nowIso,
      });
      // The file service reports quota rejections and access failures by
      // RETURNING `ok: false`, not by throwing — so the catch below never sees
      // them. Without this branch a workspace could come out of creation with no
      // README and no AGENTS.md and nothing in the log to say why.
      if (!result.ok) {
        console.error(
          `[seed] could not write ${file.path} in workspace ${workspaceId}:`,
          result.quotaExceeded ? "workspace is over its storage limit" : result,
        );
      }
    }
  } catch (error) {
    console.error(`[seed] failed to seed workspace ${workspaceId}:`, error);
  }
}