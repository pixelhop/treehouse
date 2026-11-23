import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Bump a releasable package's version, commit it, and create its release tag.
//
//   pnpm release:bump <cli|desktop> [patch|minor|major|<version>]   (default: patch)
//   pnpm release:bump:force-retag <cli|desktop> [...]               (delete + recreate the tag)
//
// Releases are tag-triggered (.github/workflows/release-{cli,desktop}.yml), and
// the two things that make hand-bumping error-prone are both handled here:
//
//   1. The tag must match package.json. release-desktop.yml FAILS the build when
//      `desktop-v<tag>` disagrees with packages/desktop/package.json, so the bump
//      and the tag have to be decided together and the tag must point at the
//      commit that carries the bump.
//   2. package.json can be BEHIND what is published. It has happened on both
//      packages (repo said cli 0.1.6 / desktop 0.1.0 while 0.1.7 / 0.1.1 were
//      live), because a release can be cut from a branch whose bump never landed
//      on main. Bumping from the local value alone then regenerates a version
//      that already exists. So the new version is derived from the HIGHER of
//      local and published.
//
// Pushing is deliberately NOT automatic: pushing a tag starts a signed,
// notarized build that publishes to the public R2 bucket. The script prints the
// exact push command and stops.

const DL_BASE = process.env.DL_BASE_URL ?? "https://dl.treehouse.pixelhop.io";

interface Target {
  dir: string;
  tagPrefix: string;
  /** Version currently advertised by the public update channel, or null if unreachable. */
  publishedVersion: () => Promise<string | null>;
}

const TARGETS: Record<string, Target> = {
  cli: {
    dir: "packages/cli",
    tagPrefix: "cli-v",
    publishedVersion: async () => {
      const body = await fetchText(`${DL_BASE}/cli/latest/latest.json`);
      if (!body) return null;
      try {
        return (JSON.parse(body) as { version?: string }).version ?? null;
      } catch {
        return null;
      }
    },
  },
  desktop: {
    dir: "packages/desktop",
    tagPrefix: "desktop-v",
    // electron-updater's manifest; the version line is the one it keys off.
    publishedVersion: async () => {
      const body = await fetchText(`${DL_BASE}/desktop/latest/latest-mac.yml`);
      return body?.match(/^version:\s*(\S+)/m)?.[1] ?? null;
    },
  },
};

/** Best-effort GET; a network failure degrades to "unknown", never a hard stop. */
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

function parse(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`unparseable version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 / 0 / 1, comparing only the release triple (prerelease suffixes ignored). */
function compare(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

function bump(from: string, kind: "patch" | "minor" | "major"): string {
  const [maj, min, pat] = parse(from);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      "usage: pnpm release:bump <cli|desktop> [patch|minor|major|<version>] [--dry-run] [--force-tag]",
      "",
      "  Bumps the package version (never below what is already published),",
      "  commits it, and creates the release tag. Push the tag yourself to",
      "  trigger the release build.",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const dryRun = flags.has("--dry-run");
  const forceTag = flags.has("--force-tag");

  const name = positional[0];
  if (!name) usage("which package? (cli or desktop)");
  const target = TARGETS[name];
  if (!target)
    usage(`unknown package "${name}" — expected one of: ${Object.keys(TARGETS).join(", ")}`);

  const spec = positional[1] ?? "patch";
  const pkgPath = join(target.dir, "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const local = (JSON.parse(raw) as { version: string }).version;

  const published = await target.publishedVersion();
  if (published === null) {
    console.warn(
      `warning: could not read the published ${name} version from ${DL_BASE} — ` +
        "bumping from package.json alone, so double-check the result isn't already released.",
    );
  } else if (compare(published, local) > 0) {
    console.warn(
      `note: package.json (${local}) is behind the published ${name} release (${published}) — ` +
        "bumping from the published version.",
    );
  }

  // The floor is whichever is higher: a bump must always clear what is live.
  const base = published && compare(published, local) > 0 ? published : local;
  const next =
    spec === "patch" || spec === "minor" || spec === "major"
      ? bump(base, spec)
      : /^\d+\.\d+\.\d+$/.test(spec)
        ? spec
        : usage(`"${spec}" is neither a bump kind nor an x.y.z version`);

  if (compare(next, base) <= 0) {
    usage(`${next} is not newer than ${base} — a released version can never be re-cut`);
  }

  const tag = `${target.tagPrefix}${next}`;
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const tagExists = git(["tag", "--list", tag]) === tag;
  if (tagExists && !forceTag) {
    usage(`tag ${tag} already exists — use release:bump:force-retag to delete and recreate it`);
  }

  console.log(`${name}: ${local} → ${next}   tag ${tag}   branch ${branch}`);
  if (branch !== "main") {
    // Not fatal: cutting a release from a branch is how the repo ended up with a
    // published version its main never had, so say it out loud rather than block.
    console.warn(`warning: not on main — a tag cut here won't be reachable from main.`);
  }
  if (dryRun) {
    console.log("(dry run — nothing written, committed or tagged)");
    return;
  }

  writeFileSync(pkgPath, raw.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
  git(["add", pkgPath]);
  git(["commit", "-m", `chore(release): ${name} v${next}`]);
  if (tagExists) git(["tag", "-d", tag]);
  git(["tag", tag]);

  console.log(
    [
      "",
      `committed and tagged ${tag}.`,
      "",
      "  push to start the release build:",
      `    git push origin ${branch} && git push origin ${tag}${forceTag ? " --force" : ""}`,
    ].join("\n"),
  );
}

main().catch((e: unknown) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});