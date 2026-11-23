// End-to-end check of the supervisor's duplicate-engine window.
//
// Runs the REAL daemon (its own TREEHOUSE_HOME) over a folder big enough that
// the bootstrap takes a while, then sends `reload` — what the desktop shell does
// on sign-in, folder changes, and "Start sync" — while that bootstrap is still
// running. Counts how many engines end up watching the one root.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = new URL("../..", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const home = mkdtempSync(join(tmpdir(), "th-home-"));
const root = mkdtempSync(join(tmpdir(), "th-reload-"));
const setup = JSON.parse(
  spawnSync(`${REPO}/node_modules/.bin/tsx`, [`${REPO}/scripts/investigation/setup.mts`, root], {
    encoding: "utf8",
    cwd: REPO,
  })
    .stdout.trim()
    .split("\n")
    .pop() as string,
) as { workspaceId: string };

// Enough files that the bootstrap's scan + upload spans several seconds.
for (let i = 0; i < 250; i++) {
  mkdirSync(join(root, "bulk"), { recursive: true });
  writeFileSync(join(root, "bulk", `f${i}.md`), `# ${i}\n${"x".repeat(3000)}\n`);
}
writeFileSync(
  join(home, "links.json"),
  JSON.stringify({ links: [{ root, workspaceId: setup.workspaceId }] }, null, 2),
);

const env = { ...process.env, TREEHOUSE_HOME: home };
const daemon = spawn(
  `${REPO}/node_modules/.bin/tsx`,
  [`${REPO}/packages/cli/src/index.ts`, "daemon"],
  {
    cwd: REPO,
    env,
  },
);
daemon.stderr.on("data", (b) => process.stderr.write(b));

// Reload repeatedly WHILE the first bootstrap is still in flight.
const reloads = Number(process.env.INV_RELOADS ?? 4);
await sleep(1200);
for (let i = 0; i < reloads; i++) {
  const r = spawnSync(
    `${REPO}/node_modules/.bin/tsx`,
    [`${REPO}/scripts/investigation/send-reload.mts`],
    { env, cwd: REPO, encoding: "utf8" },
  );
  console.log(`  reload ${i}: ${r.stdout.trim() || r.stderr.trim().slice(0, 200)}`);
  await sleep(400);
}

// Let every engine that was started finish its bootstrap, or a duplicate still
// uploading when we kill the daemon never reaches its "watching" line and the
// leak reads as absent.
await sleep(Number(process.env.INV_SETTLE_MS ?? 180000));
daemon.kill("SIGTERM");
await sleep(2000);

const log = readFileSync(join(home, "logs", "daemon.log"), "utf8");
const lines = log.split("\n");
const watching = lines.filter((l) => l.includes("] watching ")).length;
const bootstraps = lines.filter((l) => l.includes("] bootstrap: ")).length;
console.log(`\nreloads sent during bootstrap: ${reloads}`);
console.log(`bootstraps run for one root:   ${bootstraps}`);
console.log(`ENGINES WATCHING ONE ROOT:     ${watching}`);
console.log(
  watching === 1 && bootstraps === 1
    ? "OK — one engine"
    : `LEAK — ${bootstraps} bootstraps, ${watching} watchers on one folder`,
);