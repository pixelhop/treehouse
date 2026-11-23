#!/usr/bin/env node
/**
 * Per-worktree dev environments.
 *
 * Every git worktree gets an isolated dev env that can run alongside the
 * others: portless gives it branch-prefixed hostnames, this script gives it
 * its own Postgres database (in the shared docker container), its own BullMQ
 * queue prefix, and generated .env files. Blob storage (.data/) is already
 * per-worktree because it's a relative path.
 *
 *   node scripts/dev-env.mjs dev [--only api,app] [--workers] [--clone]
 *   node scripts/dev-env.mjs setup [--clone]
 *   node scripts/dev-env.mjs status
 *   node scripts/dev-env.mjs teardown   # drop THIS worktree's database
 *   node scripts/dev-env.mjs prune      # drop databases of removed worktrees
 *
 * The primary checkout (slug = none) keeps its historical `postgres` database
 * and existing .env files; worktrees get `treehouse_wt_<slug>` databases.
 * `setup`/`dev` auto-run `prune`, so orphaned databases disappear the next
 * time any env starts.
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_COMPOSE = path.join(ROOT, "packages/db/docker-compose.yml");
const REDIS_COMPOSE = path.join(ROOT, "packages/workers/docker-compose.yml");
const DB_PREFIX = "treehouse_wt_";
const REDIS_PORT = 6380;

// `execFileSync` returns null when stdout is inherited rather than piped, so the
// trim has to tolerate that — several callers here run purely for their side
// effect and inherit stdout to stream progress. Without the guard, `env:setup`
// crashed on exactly the checkout that needed it most: a fresh worktree, where
// ensureDeps() actually has to run `pnpm install`.
function sh(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, { cwd: ROOT, encoding: "utf-8", ...opts });
  return out == null ? "" : out.trim();
}
const git = (...args) => sh("git", args);

/** Worktree slug — same algorithm as portless (branch last segment, sanitized). */
function sanitize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function slugForBranch(branch) {
  if (!branch || branch === "HEAD" || branch === "main" || branch === "master") return null;
  return sanitize(branch.split("/").pop()) || null;
}
function getSlug() {
  const gitDir = path.resolve(ROOT, git("rev-parse", "--git-dir"));
  const commonDir = path.resolve(ROOT, git("rev-parse", "--git-common-dir"));
  if (gitDir === commonDir) return null; // primary checkout
  return slugForBranch(git("rev-parse", "--abbrev-ref", "HEAD"));
}

const dbNameFor = (slug) => (slug ? DB_PREFIX + slug.replace(/-/g, "_") : "postgres");

function portlessGet(name) {
  return sh("portless", ["get", name], { stdio: ["ignore", "pipe", "inherit"] });
}

// ---------------------------------------------------------------- infra

function psql(sql, db = "postgres") {
  return sh("docker", [
    "compose",
    "-f",
    DB_COMPOSE,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    db,
    "-tAc",
    sql,
  ]);
}

function ensurePostgres() {
  sh("docker", ["compose", "-f", DB_COMPOSE, "up", "-d", "--wait"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
    setTimeout(() => (sock.destroy(), resolve(false)), 1000);
  });
}

async function ensureRedis() {
  // Anything answering on 6380 counts — the redis container is shared and may
  // already be running from another project/worktree.
  if (await portInUse(REDIS_PORT)) return;
  sh("docker", ["compose", "-f", REDIS_COMPOSE, "up", "-d"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
}

// ---------------------------------------------------------------- env files

function writeEnvFiles(slug, dbName) {
  const secrets = () => crypto.randomBytes(32).toString("hex");
  const pkgs = ["db", "api", "app", "workers"];
  for (const pkg of pkgs) {
    const envPath = path.join(ROOT, "packages", pkg, ".env");
    if (fs.existsSync(envPath)) continue; // never clobber an existing .env
    const example = path.join(ROOT, "packages", pkg, ".env.example");
    let content = fs.readFileSync(example, "utf-8");
    content = content.replace(/(127\.0\.0\.1:54328\/)postgres/g, `$1${dbName}`);
    if (pkg === "api") {
      content = content
        .replace(/^BETTER_AUTH_SECRET=""$/m, `BETTER_AUTH_SECRET="${secrets()}"`)
        .replace(/^SHARE_COOKIE_SECRET=""$/m, `SHARE_COOKIE_SECRET="${secrets()}"`);
    }
    if (pkg === "workers" && slug) {
      content += `\n# Namespaces BullMQ keys on the shared Redis (set per worktree)\nNITRO_QUEUE_PREFIX="bull-${slug}"\n`;
    }
    fs.writeFileSync(envPath, content);
    console.log(`[env] wrote packages/${pkg}/.env (db: ${dbName})`);
  }
}

// ---------------------------------------------------------------- db

function dbExists(name) {
  return psql(`SELECT 1 FROM pg_database WHERE datname='${name}'`) === "1";
}

function databaseUrl(dbName) {
  return `postgresql://postgres:postgres@127.0.0.1:54328/${dbName}`;
}

function ensureDatabase(slug, { clone = false } = {}) {
  const dbName = dbNameFor(slug);
  if (slug && !dbExists(dbName)) {
    let created = false;
    if (clone) {
      // Instant copy of the primary checkout's data. Needs the source db idle
      // (no running main dev server) — fall back to an empty db otherwise.
      try {
        psql(`CREATE DATABASE "${dbName}" TEMPLATE postgres`);
        console.log(`[db] created ${dbName} (cloned from main's data)`);
        created = true;
      } catch {
        console.warn(`[db] clone failed (main db busy?) — creating empty database instead`);
      }
    }
    if (!created) {
      psql(`CREATE DATABASE "${dbName}"`);
      console.log(`[db] created ${dbName}`);
    }
  }
  sh("pnpm", ["--filter", "db", "exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl(dbName) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return dbName;
}

// ---------------------------------------------------------------- lifecycle

function ensureDeps() {
  if (fs.existsSync(path.join(ROOT, "node_modules"))) return;
  console.log("[deps] node_modules missing — running pnpm install...");
  sh("pnpm", ["install"], { stdio: ["ignore", "inherit", "inherit"] });
}

async function setup({ clone = false } = {}) {
  const slug = getSlug();
  const dbName = dbNameFor(slug);
  console.log(`[env] ${slug ? `worktree env "${slug}"` : "primary checkout (main env)"}`);
  ensureDeps();
  ensurePostgres();
  writeEnvFiles(slug, dbName);
  ensureDatabase(slug, { clone });
  prune({ quiet: true });
  return slug;
}

/** Drop databases whose worktree no longer exists. */
function prune({ quiet = false } = {}) {
  const active = new Set();
  let wt = null;
  for (const line of git("worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) wt = { path: line.slice(9) };
    if (line.startsWith("branch refs/heads/") && wt) {
      const slug = slugForBranch(line.slice("branch refs/heads/".length));
      if (slug) active.add(dbNameFor(slug));
    }
  }
  const existing = psql(`SELECT datname FROM pg_database WHERE datname LIKE '${DB_PREFIX}%'`)
    .split("\n")
    .filter(Boolean);
  const orphans = existing.filter((name) => !active.has(name));
  for (const name of orphans) {
    psql(`DROP DATABASE "${name}" WITH (FORCE)`);
    console.log(`[prune] dropped orphaned database ${name}`);
  }
  if (!quiet && orphans.length === 0) console.log("[prune] nothing to prune");
}

function teardown() {
  const slug = getSlug();
  if (!slug) {
    console.error(
      "teardown: refusing to touch the primary checkout's database. Use it from a worktree.",
    );
    process.exit(1);
  }
  const dbName = dbNameFor(slug);
  if (dbExists(dbName)) {
    psql(`DROP DATABASE "${dbName}" WITH (FORCE)`);
    console.log(`[teardown] dropped database ${dbName}`);
  } else {
    console.log(`[teardown] database ${dbName} does not exist — nothing to do`);
  }
  console.log(
    "[teardown] .env files and .data/ blobs live inside the worktree and vanish with `git worktree remove`.",
  );
}

function status() {
  const slug = getSlug();
  const dbName = dbNameFor(slug);
  console.log(`env:      ${slug ?? "main (primary checkout)"}`);
  console.log(`app:      ${portlessGet("treehouse")}`);
  console.log(`api:      ${portlessGet("api.treehouse")}`);
  console.log(`workers:  ${portlessGet("workers.treehouse")}`);
  try {
    console.log(
      `database: ${dbName} (${dbExists(dbName) ? "exists" : "missing — run pnpm env:setup"})`,
    );
  } catch {
    console.log(`database: ${dbName} (postgres not running — run pnpm dev:db)`);
  }
}

// ---------------------------------------------------------------- dev runner

const COLORS = { api: "\x1b[36m", app: "\x1b[35m", workers: "\x1b[33m" };

function runService(name, portlessName, filter, tool, extraEnv) {
  // `portless run --name <x>` (NOT `portless <x>`) — the positional-name form
  // skips worktree prefixing, which would collide across worktrees.
  const child = spawn(
    "portless",
    ["run", "--name", portlessName, "pnpm", "--filter", filter, "exec", tool, "dev"],
    {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const tag = `${COLORS[name]}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) out.write(tag + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
}

async function dev(args) {
  const onlyArg = args.find((a) => a.startsWith("--only"));
  const only = onlyArg
    ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1]).split(",")
    : null;
  const withWorkers = args.includes("--workers");
  const services = only ?? ["api", "app", ...(withWorkers ? ["workers"] : [])];

  const slug = await setup({ clone: args.includes("--clone") });
  if (services.includes("workers")) await ensureRedis();

  const appUrl = portlessGet("treehouse");
  const apiUrl = portlessGet("api.treehouse");
  console.log(`[env] app -> ${appUrl}`);
  console.log(`[env] api -> ${apiUrl}`);

  const children = [];
  if (services.includes("api"))
    children.push(
      runService("api", "api.treehouse", "api", "nitro", {
        BETTER_AUTH_URL: apiUrl,
        APP_URL: appUrl,
      }),
    );
  if (services.includes("app"))
    // Short TMPDIR: Nuxt's vite-node unix socket under the default macOS
    // /var/folders/... temp dir exceeds the 104-char sun_path limit and the
    // dev server 500s on every request.
    children.push(
      runService("app", "treehouse", "app", "nuxt", {
        NUXT_PUBLIC_API_URL: apiUrl,
        TMPDIR: "/tmp",
      }),
    );
  if (services.includes("workers"))
    children.push(
      runService(
        "workers",
        "workers.treehouse",
        "workers",
        "nitro",
        slug ? { NITRO_QUEUE_PREFIX: `bull-${slug}` } : {},
      ),
    );

  const shutdown = () => {
    for (const c of children) c.kill("SIGINT");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  for (const c of children) {
    c.on("exit", (code) => {
      shutdown();
      process.exitCode = code ?? 0;
    });
  }
}

// ---------------------------------------------------------------- main

const [cmd = "dev", ...rest] = process.argv.slice(2);
switch (cmd) {
  case "dev":
    await dev(rest);
    break;
  case "setup":
    await setup({ clone: rest.includes("--clone") });
    console.log("[env] ready");
    break;
  case "teardown":
    teardown();
    break;
  case "prune":
    ensurePostgres();
    prune();
    break;
  case "status":
    status();
    break;
  default:
    console.error(`Unknown command: ${cmd}. Use dev | setup | teardown | prune | status`);
    process.exit(1);
}