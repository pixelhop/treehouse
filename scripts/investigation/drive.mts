// Reproduction matrix driver. Spawns the instrumented engine against a fresh
// disposable workspace, runs one scenario, then reports every file that exists
// locally and remotely with content hashes.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const scenario = process.argv[2];
if (!scenario) throw new Error("usage: drive.mts <scenario>");
const REPO = new URL("../..", import.meta.url).pathname;
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), `th-${scenario}-`));
const logPath = `${root}.trace.jsonl`;
const setup = JSON.parse(
  spawnSync(`${REPO}/node_modules/.bin/tsx`, [`${REPO}/scripts/investigation/setup.mts`, root], {
    encoding: "utf8",
    cwd: REPO,
  })
    .stdout.trim()
    .split("\n")
    .pop() as string,
) as { base: string; apiKey: string; agentKey: string; workspaceId: string };

const say = (m: string) => {
  console.log(m);
  appendFileSync(logPath, `${JSON.stringify({ t: -1, event: "driver", msg: m })}\n`);
};
say(`root=${root}  ws=${setup.workspaceId}`);

const child = spawn(
  `${REPO}/node_modules/.bin/tsx`,
  [`${REPO}/scripts/investigation/engine-run.mts`, root],
  {
    cwd: REPO,
    env: {
      ...process.env,
      INV_POLL_MS: process.env.INV_POLL_MS ?? "2000",
      INV_RECONCILE_MS: process.env.INV_RECONCILE_MS ?? "300000",
    },
  },
);
child.stdout.on("data", (b) => appendFileSync(logPath, b));
child.stderr.on("data", (b) =>
  appendFileSync(logPath, `${JSON.stringify({ event: "stderr", msg: String(b) })}\n`),
);

async function waitFor(event: string, timeoutMs = 30000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (readFileSync(logPath, "utf8").includes(`"event":"${event}"`)) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${event}`);
}

// --- workspace helpers -----------------------------------------------------
const abs = (p: string) => join(root, p);
const write = (p: string, s: string) => {
  mkdirSync(join(root, p, "..").replace(/\/\.\.$/, ""), { recursive: true });
  writeFileSync(abs(p), s);
};
const api = async (path: string, init: RequestInit = {}) =>
  fetch(`${setup.base}/api/workspaces/${setup.workspaceId}/${path}`, {
    ...init,
    headers: { "x-api-key": setup.apiKey, ...init.headers },
  });

function localFiles(): string[] {
  return (readdirSync(root, { recursive: true, withFileTypes: true }) as any[])
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .filter((p) => !p.startsWith(".treehouse"))
    .sort();
}

async function report(label: string): Promise<void> {
  const remote = (
    (await (await api("list")).json()) as { entries: { path: string; version: number }[] }
  ).entries;
  say(`\n=== ${label} ===`);
  say("LOCAL:");
  for (const p of localFiles()) say(`  ${sha(readFileSync(abs(p)))}  ${p}`);
  say("REMOTE:");
  for (const e of remote.sort((a, b) => a.path.localeCompare(b.path)))
    say(`  v${e.version}  ${e.path}`);
  const conflicts = localFiles().filter((p) => p.includes("conflicted copy"));
  say(`CONFLICTS: ${conflicts.length}`);
  // Group by content hash: several byte-identical copies of one losing state is
  // the exact signature reported in the incident note.
  const byHash = new Map<string, string[]>();
  for (const c of conflicts) {
    const h = sha(readFileSync(abs(c)));
    byHash.set(h, [...(byHash.get(h) ?? []), c]);
  }
  for (const [h, ps] of byHash)
    if (ps.length > 1) say(`  DUPLICATE x${ps.length} (${h}): ${ps[0]}`);
  // Divergence check: local content that never reached the remote.
  const remoteMap = new Map(remote.map((e) => [e.path, e.version]));
  for (const p of localFiles()) {
    if (!remoteMap.has(p)) {
      say(`  LOCAL-ONLY (never uploaded): ${p}`);
      continue;
    }
    const body = new Uint8Array(
      await (await api(`files/${p.split("/").map(encodeURIComponent).join("/")}`)).arrayBuffer(),
    );
    if (sha(body) !== sha(readFileSync(abs(p)))) say(`  DIVERGED local!=remote: ${p}`);
  }
}

// --- scenarios -------------------------------------------------------------
const ORIGINAL = `---\ntitle: Plan\n---\n\n# Plan\n\nSee [notes](../notes/notes.md) and [budget](../budget.md).\n`;
const REBASED = ORIGINAL.replace(/\.\.\//g, "../../../");

async function scenarios(): Promise<void> {
  switch (scenario) {
    // 1. create once, wait for a clear ack, edit once
    case "s1-create-wait-edit":
      write("a.md", ORIGINAL);
      await sleep(6000);
      write("a.md", REBASED);
      await sleep(6000);
      break;

    // 2. create and immediately edit once
    case "s2-create-edit-immediate":
      write("b.md", ORIGINAL);
      write("b.md", REBASED);
      await sleep(8000);
      break;

    // 3. copy a file, immediately rebase its links (the documented repro)
    case "s3-copy-rebase":
      write("src/plan.md", ORIGINAL);
      await sleep(6000);
      mkdirSync(abs("versions/2026-08-14"), { recursive: true });
      cpSync(abs("src/plan.md"), abs("versions/2026-08-14/plan.md"));
      writeFileSync(abs("versions/2026-08-14/plan.md"), REBASED);
      await sleep(10000);
      break;

    // 4. create then several rapid patches
    case "s4-rapid-patches":
      write("c.md", ORIGINAL);
      for (let i = 0; i < 6; i++) {
        await sleep(120);
        write("c.md", `${REBASED}\npatch ${i}\n`);
      }
      await sleep(10000);
      break;

    // 5. move a file, immediately repair its links
    case "s5-move-repair":
      write("notes/note.md", ORIGINAL);
      await sleep(6000);
      mkdirSync(abs("archive"), { recursive: true });
      renameSync(abs("notes/note.md"), abs("archive/note.md"));
      writeFileSync(abs("archive/note.md"), REBASED);
      await sleep(10000);
      break;

    // 6. copy+rebase but with a deliberate pause between the two writes
    case "s6-copy-pause-rebase":
      write("src/plan.md", ORIGINAL);
      await sleep(6000);
      mkdirSync(abs("versions/2026-08-14"), { recursive: true });
      cpSync(abs("src/plan.md"), abs("versions/2026-08-14/plan.md"));
      await sleep(6000);
      writeFileSync(abs("versions/2026-08-14/plan.md"), REBASED);
      await sleep(8000);
      break;

    // 7. control: genuine two-writer divergent edit (agent writes remotely
    //    while the human edits locally)
    case "s7-two-writer":
      write("shared.md", ORIGINAL);
      await sleep(6000);
      await api("files/shared.md", {
        method: "PUT",
        headers: {
          "content-type": "text/markdown",
          "if-match": '"1"',
          "x-api-key": setup.agentKey,
        },
        body: `${ORIGINAL}\nagent edit\n`,
      });
      writeFileSync(abs("shared.md"), `${ORIGINAL}\nhuman edit\n`);
      await sleep(10000);
      break;

    // 8. copy+rebase DURING a periodic full reconcile (the long-pass hypothesis)
    case "s8-reconcile-overlap": {
      // seed enough files that a full pass takes a while
      for (let i = 0; i < 60; i++) write(`bulk/f${i}.md`, `# file ${i}\n${"x".repeat(2000)}\n`);
      await sleep(15000);
      write("target.md", ORIGINAL);
      await sleep(6000);
      say("-- triggering a full reconcile, then editing mid-pass --");
      // The engine reconciles every INV_RECONCILE_MS; the driver sets it low for
      // this scenario so a pass is in flight while we edit.
      await sleep(500);
      writeFileSync(abs("target.md"), REBASED);
      await sleep(20000);
      break;
    }
    // 9. CHAOS: a big workspace under a continuous agent-style edit batch, with
    //    the periodic full reconcile firing throughout (INV_RECONCILE_MS).
    //    Mimics "Claude edits files in Pixelhop Home for a minute".
    case "s9-chaos": {
      for (let i = 0; i < 200; i++) write(`bulk/f${i}.md`, `# file ${i}\n${"x".repeat(4000)}\n`);
      say("-- seeded 200 files, waiting for first sync --");
      await sleep(25000);
      say("-- starting edit batch --");
      const durationMs = Number(process.env.INV_CHAOS_MS ?? 60000);
      const end = Date.now() + durationMs;
      let n = 0;
      while (Date.now() < end) {
        // the documented workflow: snapshot a note, then immediately rebase it
        const snap = `versions/snap-${n}/plan.md`;
        write(snap, ORIGINAL);
        await sleep(40);
        write(snap, REBASED);
        // and a plain edit to an existing file
        write(`bulk/f${n % 200}.md`, `# file ${n % 200} edited ${n}\n${"x".repeat(4000)}\n`);
        n++;
        await sleep(300);
      }
      say(`-- edit batch done (${n} rounds), settling --`);
      await sleep(40000);
      break;
    }

    // 10. Two sync processes on the same root: the daemon engine plus a manual
    //     one-shot `treehouse sync`, which has no cross-process guard.
    case "s10-two-process": {
      for (let i = 0; i < 40; i++) write(`bulk/f${i}.md`, `# file ${i}\n${"x".repeat(4000)}\n`);
      await sleep(15000);
      say("-- launching concurrent one-shot syncs while editing --");
      const runs: Promise<void>[] = [];
      for (let round = 0; round < 8; round++) {
        const snap = `versions/snap-${round}/plan.md`;
        write(snap, ORIGINAL);
        runs.push(
          new Promise<void>((res) => {
            const p = spawn(
              `${REPO}/node_modules/.bin/tsx`,
              [`${REPO}/scripts/investigation/one-shot.mts`, root],
              { cwd: REPO },
            );
            p.stdout.on("data", (b) =>
              appendFileSync(logPath, `${JSON.stringify({ event: "one-shot", msg: String(b) })}\n`),
            );
            p.on("exit", () => res());
          }),
        );
        await sleep(60);
        write(snap, REBASED);
        await sleep(400);
      }
      await Promise.all(runs);
      await sleep(20000);
      break;
    }

    // 11. TWO DEVICES on one workspace — the real Pixelhop Home setup from
    //     14 Aug onward: two sync clients, two local trees, one workspace.
    case "s11-two-devices": {
      const rootB = `${root}-deviceB`;
      mkdirSync(`${rootB}/.treehouse`, { recursive: true });
      writeFileSync(
        `${rootB}/.treehouse/config.json`,
        readFileSync(`${root}/.treehouse/config.json`),
      );
      const childB = spawn(
        `${REPO}/node_modules/.bin/tsx`,
        [`${REPO}/scripts/investigation/engine-run.mts`, rootB],
        { cwd: REPO, env: process.env },
      );
      childB.stdout.on("data", (b) => appendFileSync(`${logPath}.deviceB`, b));
      say(`device B root=${rootB}`);
      await sleep(12000);
      say("-- device A: snapshot + immediate rebase, repeatedly --");
      for (let i = 0; i < 6; i++) {
        const snap = `versions/snap-${i}/plan.md`;
        write(snap, ORIGINAL);
        await sleep(50);
        write(snap, REBASED);
        await sleep(2500);
      }
      await sleep(25000);
      childB.kill("SIGTERM");
      await sleep(1000);
      break;
    }

    // 12. Both devices create the SAME new path with DIFFERENT content, then
    //     device A immediately rebases its copy (the documented workflow).
    case "s12-both-new": {
      const rootB = `${root}-deviceB`;
      mkdirSync(`${rootB}/.treehouse`, { recursive: true });
      writeFileSync(
        `${rootB}/.treehouse/config.json`,
        readFileSync(`${root}/.treehouse/config.json`),
      );
      const childB = spawn(
        `${REPO}/node_modules/.bin/tsx`,
        [`${REPO}/scripts/investigation/engine-run.mts`, rootB],
        { cwd: REPO, env: process.env },
      );
      childB.stdout.on("data", (b) => appendFileSync(`${logPath}.deviceB`, b));
      await sleep(12000);
      for (let i = 0; i < 4; i++) {
        const snap = `versions/snap-${i}/plan.md`;
        mkdirSync(join(rootB, "versions", `snap-${i}`), { recursive: true });
        // device B lays down the ORIGINAL; device A lays down its own copy and
        // then rebases it a moment later.
        writeFileSync(join(rootB, snap), `${ORIGINAL}\ndevice B\n`);
        write(snap, ORIGINAL);
        await sleep(60);
        write(snap, REBASED);
        await sleep(4000);
      }
      await sleep(30000);
      childB.kill("SIGTERM");
      await sleep(1000);
      break;
    }

    // 13. Two devices + a slow origin + a rapid snapshot batch: the closest
    //     match to the 14-19 Aug conditions (5s writes, two clients, agent
    //     edit batch). Looking for BURSTS of identical copies per path.
    case "s13-burst-hunt": {
      const rootB = `${root}-deviceB`;
      mkdirSync(`${rootB}/.treehouse`, { recursive: true });
      writeFileSync(
        `${rootB}/.treehouse/config.json`,
        readFileSync(`${root}/.treehouse/config.json`),
      );
      const childB = spawn(
        `${REPO}/node_modules/.bin/tsx`,
        [`${REPO}/scripts/investigation/engine-run.mts`, rootB],
        { cwd: REPO, env: process.env },
      );
      childB.stdout.on("data", (b) => appendFileSync(`${logPath}.deviceB`, b));
      await sleep(12000);
      for (let i = 0; i < 10; i++) {
        const snap = `versions/snap-${i}/plan.md`;
        mkdirSync(join(rootB, "versions", `snap-${i}`), { recursive: true });
        writeFileSync(join(rootB, snap), `${ORIGINAL}\ndevice B\n`);
        write(snap, ORIGINAL);
        await sleep(50);
        write(snap, REBASED);
        await sleep(1200);
      }
      await sleep(45000);
      childB.kill("SIGTERM");
      await sleep(1000);
      break;
    }

    // 14. ONE device, flaky origin (the real daemon log is full of
    //     `fetch failed` / `terminated`): the server commits writes whose
    //     responses never reach the client, so the client's baseline is missing
    //     for paths that DO exist remotely.
    case "s14-flaky-origin": {
      for (let i = 0; i < 12; i++) {
        const snap = `versions/snap-${i}/plan.md`;
        write(snap, ORIGINAL);
        await sleep(50);
        write(snap, REBASED);
        await sleep(1500);
      }
      await sleep(45000);
      break;
    }

    // 15. TWO ENGINES ON ONE ROOT — the duplicate-engine leak in the daemon
    //     supervisor. One folder, one credential, one editor; the only
    //     difference is that the root is supervised twice. Looking for the
    //     production signature: several BYTE-IDENTICAL copies of one path,
    //     stamped milliseconds apart.
    case "s15-duplicate-engines": {
      const extra = Number(process.env.INV_ENGINES ?? 3);
      const twins = [];
      for (let n = 0; n < extra; n++) {
        // The duplicates' writes sit in the origin's queue while the first
        // engine's write commits — the production feed shows exactly this
        // (creates received at .23, resolved 5.4s later, a newer version
        // committed in between). INV_TWIN_PUT_DELAY_MS stands in for that
        // queueing so the outcome is deterministic instead of timing-dependent.
        const c = spawn(
          `${REPO}/node_modules/.bin/tsx`,
          [`${REPO}/scripts/investigation/engine-run.mts`, root],
          {
            cwd: REPO,
            env: { ...process.env, INV_PUT_DELAY_MS: process.env.INV_TWIN_PUT_DELAY_MS ?? "0" },
          },
        );
        c.stdout.on("data", (b) => appendFileSync(`${logPath}.twin${n}`, b));
        twins.push(c);
      }
      say(`${extra + 1} engines supervising ${root}`);
      await sleep(12000);
      say("-- snapshot, then rebase past the watcher's 1s settle --");
      const gap = Number(process.env.INV_REBASE_GAP_MS ?? 1600);
      for (let i = 0; i < 5; i++) {
        const snap = `versions/snap-${i}/plan.md`;
        write(snap, ORIGINAL);
        await sleep(gap);
        write(snap, REBASED);
        await sleep(6000);
      }
      await sleep(25000);
      for (const c of twins) c.kill("SIGTERM");
      await sleep(1500);
      break;
    }

    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

await waitFor("started");
await sleep(2000);
await scenarios();
await report("result");
child.kill("SIGTERM");
await sleep(1500);
say(`trace: ${logPath}`);