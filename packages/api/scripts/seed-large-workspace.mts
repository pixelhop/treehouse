// Seed a large workspace so sidebar performance can be measured against
// something realistic. Run from the repository root:
//
//   pnpm --filter api exec tsx scripts/seed-large-workspace.mts --count 2500
//   pnpm --filter api exec tsx scripts/seed-large-workspace.mts --from "$HOME/Documents/Pixelhop Home"
//   pnpm --filter api exec tsx scripts/seed-large-workspace.mts --count 10000 --email me@example.com
//
// It lives inside the api package rather than the repo root because pnpm's
// strict resolution means `db` and `server/utils/files` are not resolvable from
// a root-level script at all. `.mts` (not `.ts`) because the package is not
// type:module, so tsx would otherwise transform it as CJS and reject the
// top-level await the dotenv-before-import ordering depends on.
//
// Each run creates a NEW workspace rather than mutating an existing one, so it
// is safe to run repeatedly; delete workspaces you no longer want.
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { config } from "dotenv";

// The Prisma client reads DATABASE_URL eagerly at import time, so the env has to
// be loaded before anything under server/ is imported. Hence dotenv first and
// dynamic imports below (same ordering the API tests use).
config({ path: new URL("../.env", import.meta.url).pathname });

// Deliberately does NOT override the blob-store config. The script must write
// bodies wherever the running API reads them: an earlier version cleared the
// R2_* vars to force the local filesystem driver, and every seeded file then
// served a 502 in the UI because the API was still reading from R2. The env is
// the contract — if it is half-configured, useBlobStore()'s hard error is the
// correct outcome rather than something to route around here.

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");

const db = usePrismaClient();
const svc = useFileService();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const count = Number(arg("count") ?? 0);
const from = arg("from");
const email = arg("email") ?? "founder@example.com";
// Seed into an EXISTING workspace instead of creating a new org+workspace. Use
// this when the target user already has a session whose active organisation owns
// that workspace — the switcher only lists workspaces in the active org, so a
// freshly-created org would not show up until the user switched to it.
const existingWorkspace = arg("workspace");

if (!count && !from) {
  console.error("Pass --count <n> or --from <dir>. Optionally --email <user email>.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Path generation
// ---------------------------------------------------------------------------

const TOP = [
  "Clients",
  "Design",
  "Development",
  "Content-Media-Marketing",
  "Events",
  "Operations",
  "reports",
];
const MID = ["acme", "beta-corp", "internal", "2026", "archive", "drafts", "brand", "api"];
const LEAF = ["notes", "proposal", "readme", "meeting", "spec", "budget", "plan", "summary"];

/** A synthetic tree with roughly one folder per four files, matching the shape
 *  of the real workspace this was built for (1,880 files / 540 folders). */
function generatePaths(n: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const top = TOP[i % TOP.length] as string;
    const mid = MID[Math.floor(i / TOP.length) % MID.length] as string;
    const leaf = LEAF[i % LEAF.length] as string;
    const depth = i % 3;
    const dir =
      depth === 0 ? top : depth === 1 ? `${top}/${mid}` : `${top}/${mid}/${leaf}-group-${i % 7}`;
    paths.push(`${dir}/${leaf}-${i}.md`);
  }
  return paths;
}

/** Mirror a real directory's path STRUCTURE — names only, one byte of content. */
function mirrorPaths(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory — skip rather than abort the whole seed
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue; // dotfiles/dirs, as the CLI skips them
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue; // broken symlink or race — skip
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const foundUser = await db.user.findFirst({ where: { email } });
if (!foundUser) {
  console.error(`No user with email ${email}. Sign up in the app first, or pass --email.`);
  process.exit(1);
}
// Bound separately so the narrowing survives into the worker closure below.
const user = foundUser;

const stamp = new Date()
  .toISOString()
  .replace(/[^0-9]/g, "")
  .slice(0, 14);
let workspace: { id: string };
let orgLabel: string;

if (existingWorkspace) {
  const found = await db.workspace.findUnique({ where: { id: existingWorkspace } });
  if (!found) {
    console.error(`No workspace ${existingWorkspace}.`);
    process.exit(1);
  }
  workspace = found;
  orgLabel = found.organizationId;
} else {
  const org = await db.organization.create({
    data: { id: `org_perf_${stamp}`, name: `Perf ${stamp}`, slug: `perf-${stamp}` },
  });
  // Without a member row, authorizeWorkspace() throws 403 "Not a workspace
  // member" and the switcher never lists the workspace — a seeded workspace
  // nobody can open is useless.
  await db.member.create({
    data: { id: `mem_perf_${stamp}`, organizationId: org.id, userId: user.id, role: "owner" },
  });
  workspace = await db.workspace.create({
    data: { organizationId: org.id, name: from ? "Perf (mirrored)" : `Perf (${count})` },
  });
  orgLabel = org.id;
}

const paths = from ? mirrorPaths(from) : generatePaths(count);
console.log(`Seeding ${paths.length} files into workspace ${workspace.id}…`);

const body = new TextEncoder().encode("x");
const nowIso = new Date().toISOString();
const POOL = 10;
let done = 0;

async function worker(slice: string[]) {
  for (const path of slice) {
    await svc.write({
      workspaceId: workspace.id,
      path,
      body,
      actor: { principal: "human", actorId: user.id, access: "trusted" },
      nowIso,
    });
    done += 1;
    if (done % 250 === 0) console.log(`  ${done}/${paths.length}`);
  }
}

const slices: string[][] = Array.from({ length: POOL }, () => []);
paths.forEach((p, i) => (slices[i % POOL] as string[]).push(p));
await Promise.all(slices.map(worker));

const folders = new Set<string>();
for (const p of paths) {
  const parts = p.split("/");
  for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
}

console.log("");
console.log(`Seeded ${paths.length} files across ${folders.size} folders.`);
console.log(`Workspace: ${workspace.id}`);
console.log(`Org:       ${orgLabel} (owner: ${email})`);
console.log("");
console.log("Open it at /w/" + workspace.id + " once the org is active for that user.");
process.exit(0);