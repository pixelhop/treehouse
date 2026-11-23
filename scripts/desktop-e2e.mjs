#!/usr/bin/env node
// Drive the REAL desktop app (unpackaged Electron) against a local stack, in a
// sandbox that cannot touch your real links, daemon, synced folders, launchd
// service or treehouse:// handler. See docs/desktop/e2e-harness.md for the
// walkthroughs this exists to make repeatable.
//
//   node scripts/desktop-e2e.mjs stack            start api :3110 + app :3100 (IPv4), wait for ready
//   node scripts/desktop-e2e.mjs launch [--fresh] [--link <url>]  build + launch (CDP :9333), optionally cold-started from a link
//   node scripts/desktop-e2e.mjs deeplink <url>   deliver a treehouse:// link (second instance)
//   node scripts/desktop-e2e.mjs open <url>       fire it through macOS `open` (needs E2E_REAL_PROTOCOL=1 launch)
//   node scripts/desktop-e2e.mjs dialog           print the native dialog the app is waiting on
//   node scripts/desktop-e2e.mjs answer <n|path|cancel>  answer it (button index / folder / cancel)
//   node scripts/desktop-e2e.mjs state            links, folders, onboarding record, journal tail
//   node scripts/desktop-e2e.mjs quit             quit the app (daemon + stack keep running)
//   node scripts/desktop-e2e.mjs down [--wipe]    stop everything, restore the treehouse:// handler
//
// Drive the windows with agent-browser:
//   agent-browser --session desktop connect 9333   (the app)
//   agent-browser --session web open http://127.0.0.1:3100   (a normal browser)
//
// Env knobs: E2E_APP_PORT (3100), E2E_API_PORT (3110), E2E_CDP_PORT (9333),
// E2E_REAL_PROTOCOL=1 lets the dev app claim treehouse:// so `open treehouse://…`
// from a real browser reaches it (restored by `down`).

import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const E2E = path.join(ROOT, ".e2e");
const SANDBOX = path.join(E2E, "sandbox");
const HOME = path.join(SANDBOX, "home"); // ~ for the app: folders land in <HOME>/Treehouse
const TH_HOME = path.join(SANDBOX, "th"); // TREEHOUSE_HOME: links.json, daemon, profile
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3100);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3110);
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9333);
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const ELECTRON = path.join(ROOT, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const MAIN = path.join(ROOT, "packages/desktop/dist/main.cjs");
const INSTALLED_BUNDLE_ID = "io.treehouse.desktop";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The environment every sandboxed process runs with. */
function sandboxEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Hosts built on Electron (T3 Code, VS Code terminals…) export this, and it makes
  // Electron boot as plain Node: the app dies on `app.isPackaged` of undefined.
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    ...env,
    HOME,
    TREEHOUSE_HOME: TH_HOME,
    // Stops the CLI installing/rewriting the REAL ~/Library/LaunchAgents plist,
    // which TREEHOUSE_HOME does not isolate.
    NODE_ENV: "test",
    TREEHOUSE_APP_ORIGIN: APP_ORIGIN,
    TREEHOUSE_E2E: "1",
  };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function waitFor(label, check, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function bg(cmd, args, { cwd = ROOT, env = process.env, log }) {
  fs.mkdirSync(E2E, { recursive: true });
  const out = fs.openSync(path.join(E2E, log), "a");
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  return child.pid;
}

function pgrep(pattern) {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  return r.stdout.split("\n").filter(Boolean).map(Number);
}

function pkill(pattern) {
  spawnSync("pkill", ["-f", pattern]);
}

/** Kill and WAIT: a relaunch racing a still-exiting app sees "already running". */
async function stop(pattern) {
  pkill(pattern);
  for (let i = 0; i < 50 && pgrep(pattern).length; i++) await sleep(100);
  if (pgrep(pattern).length) spawnSync("pkill", ["-9", "-f", pattern]);
}

/** The macOS default handler for treehouse://, via LaunchServices. */
function urlHandler(set) {
  const swift = `import CoreServices
import Foundation
let a = CommandLine.arguments
if a.count > 1 { _ = LSSetDefaultHandlerForURLScheme("treehouse" as CFString, a[1] as CFString) }
if let h = LSCopyDefaultHandlerForURLScheme("treehouse" as CFString)?.takeRetainedValue() { print(h) } else { print("none") }`;
  const file = path.join(E2E, "lshandler.swift");
  fs.mkdirSync(E2E, { recursive: true });
  fs.writeFileSync(file, swift);
  const r = spawnSync("swift", [file, ...(set ? [set] : [])], { encoding: "utf8" });
  return r.stdout.trim().split("\n").pop();
}

// ─────────────────────────────── commands ───────────────────────────────

async function stack() {
  const descriptorOk = async () => {
    const r = await fetch(`${APP_ORIGIN}/.well-known/treehouse`, { redirect: "error" });
    return r.ok && (await r.json()).apiUrl === API_ORIGIN;
  };
  const apiOk = async () => (await fetch(`${API_ORIGIN}/api/health`)).ok;

  if (!(await portOpen(API_PORT))) {
    // IPv4 on purpose: Nitro's dev server otherwise binds [::1] only, and the
    // 127.0.0.1 apiUrl the descriptor advertises refuses every call.
    bg("pnpm", ["exec", "nitro", "dev", "--port", String(API_PORT), "--host", "127.0.0.1"], {
      cwd: path.join(ROOT, "packages/api"),
      env: { ...process.env, HOST: "127.0.0.1", APP_URL: APP_ORIGIN, BETTER_AUTH_URL: API_ORIGIN },
      log: "api.log",
    });
  }
  if (!(await portOpen(APP_PORT))) {
    // 127.0.0.1, not localhost: on localhost the descriptor 308s to a trailing
    // slash and the shell (redirect: "error") calls it "not a Treehouse server".
    bg("pnpm", ["exec", "nuxt", "dev", "--port", String(APP_PORT), "--host", "127.0.0.1"], {
      cwd: path.join(ROOT, "packages/app"),
      env: {
        ...process.env,
        TMPDIR: "/tmp",
        NUXT_PUBLIC_API_URL: API_ORIGIN,
        NUXT_DEVTOOLS: "false",
      },
      log: "app.log",
    });
  }
  await waitFor("api", apiOk);
  await waitFor("app descriptor", descriptorOk);
  console.log(`stack ready  app ${APP_ORIGIN}  api ${API_ORIGIN}`);
}

function ensureDaemon() {
  if (pgrep(`treehouse.mjs daemon`).length && fs.existsSync(path.join(TH_HOME, "daemon.sock")))
    return;
  bg("node", ["packages/cli/bin/treehouse.mjs", "daemon"], {
    env: sandboxEnv(),
    log: "daemon.out",
  });
}

async function launch(flags) {
  if (pgrep(`${MAIN}`).length) {
    console.log("app already running — `quit` first");
    return;
  }
  if (flags.includes("--fresh")) {
    await stop("treehouse.mjs daemon");
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    await sleep(500);
  }
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(TH_HOME, { recursive: true });
  execFileSync("node", ["packages/desktop/scripts/build.mjs"], { cwd: ROOT, stdio: "ignore" });
  ensureDaemon();

  const realProtocol = process.env.E2E_REAL_PROTOCOL === "1";
  if (realProtocol) {
    const before = urlHandler();
    if (before.toLowerCase() !== "com.github.electron")
      fs.writeFileSync(path.join(E2E, "handler-before"), before);
  }
  // `--link <treehouse://…>` cold-starts the app FROM a link, the way a first
  // launch from "Open … in Treehouse" does (argv path; macOS's own cold start
  // delivers it via open-url, which `open` exercises once the app is registered).
  const linkAt = flags.indexOf("--link");
  const link = linkAt >= 0 ? flags[linkAt + 1] : undefined;
  bg(ELECTRON, [MAIN, `--remote-debugging-port=${CDP_PORT}`, ...(link ? [link] : [])], {
    env: sandboxEnv(realProtocol ? { TREEHOUSE_DEV_PROTOCOL: "1" } : {}),
    log: "electron.out",
  });
  await waitFor("CDP", () => portOpen(CDP_PORT), 30_000);
  console.log(`app up  CDP :${CDP_PORT}  sandbox ${path.relative(ROOT, SANDBOX)}`);
  console.log(`  agent-browser --session desktop connect ${CDP_PORT}`);
}

/** Fire a link through macOS itself (`open`), the path a browser click takes.
 * REFUSES unless the dev app owns treehouse:// — otherwise LaunchServices hands
 * the link to the INSTALLED Treehouse, which then starts onboarding against the
 * local test server on your real profile. (Learned the hard way.) */
function openReal(url) {
  if (!url?.startsWith("treehouse://")) throw new Error("usage: open treehouse://…");
  const handler = urlHandler();
  if (handler.toLowerCase() !== "com.github.electron") {
    throw new Error(
      `treehouse:// is owned by ${handler}, not the dev app — relaunch with E2E_REAL_PROTOCOL=1 first`,
    );
  }
  execFileSync("open", [url]);
  console.log(`opened via LaunchServices: ${url}`);
}

function deeplink(url) {
  if (!url?.startsWith("treehouse://")) throw new Error("usage: deeplink treehouse://…");
  // A second launch hands its argv to the running instance (single-instance lock,
  // keyed on the userData dir the sandbox env selects) and exits. Same code path
  // as Windows/Linux and a warm macOS hand-off.
  spawnSync(ELECTRON, [MAIN, url], { env: sandboxEnv(), stdio: "ignore", timeout: 20_000 });
  console.log(`delivered ${url}`);
}

/** Waiting dialogs, oldest first. Several can be open at once (a stale Retry
 * prompt beneath a newer flow's picker), each with its own id. */
function pendingDialogs() {
  const dir = path.join(TH_HOME, "e2e");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^dialog-\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .sort((a, b) => a.id - b.id);
}

function dialogState() {
  const all = pendingDialogs();
  if (all.length === 0) {
    console.log("no dialog waiting");
    return;
  }
  for (const d of all) {
    const o = d.options;
    console.log(`${d.kind} dialog #${d.id}: ${o.title ?? ""}`);
    if (o.message) console.log(`  message: ${o.message}`);
    if (o.detail) console.log(`  detail:  ${String(o.detail).replace(/\n/g, "\n           ")}`);
    if (o.buttons) console.log(`  buttons: ${o.buttons.map((b, i) => `[${i}] ${b}`).join("  ")}`);
    if (o.defaultPath) console.log(`  default: ${o.defaultPath}`);
    if (o.buttonLabel) console.log(`  confirm: ${o.buttonLabel}`);
  }
}

/** Answer a waiting dialog — the newest by default, or `#<id>` as a second arg. */
function answer(arg, which) {
  if (arg === undefined)
    throw new Error("usage: answer <buttonIndex|/abs/path|default|cancel> [#id]");
  const all = pendingDialogs();
  const d = which ? all.find((x) => `#${x.id}` === which || String(x.id) === which) : all.at(-1);
  if (!d) throw new Error("no such dialog waiting");
  let a;
  if (arg === "cancel") a = { canceled: true, response: d.options?.cancelId ?? 0 };
  else if (/^\d+$/.test(arg)) a = { response: Number(arg) };
  else if (arg === "default") a = { filePaths: [d.options?.defaultPath].filter(Boolean) };
  else {
    const abs = path.resolve(arg);
    fs.mkdirSync(abs, { recursive: true }); // the real picker can create folders too
    a = { filePaths: [abs] };
  }
  fs.writeFileSync(path.join(TH_HOME, "e2e", `dialog-${d.id}-answer.json`), JSON.stringify(a));
  console.log(`answered #${d.id} ${JSON.stringify(a)}`);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function state() {
  const rel = (p) => (p?.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
  const links = readJson(path.join(TH_HOME, "links.json")) ?? [];
  const list = Array.isArray(links) ? links : (links.links ?? []);
  console.log(`links.json (${list.length})`);
  for (const l of list) {
    const cfg = readJson(path.join(l.root, ".treehouse", "config.json"));
    const st = readJson(path.join(l.root, ".treehouse", "state.json"));
    const agree = cfg?.workspaceId === l.workspaceId ? "" : `  ⚠ config says ${cfg?.workspaceId}`;
    console.log(`  ${rel(l.root)}  → ${l.workspaceId}${l.paused ? " (paused)" : ""}${agree}`);
    if (st)
      console.log(`      status: ${st.state ?? st.status ?? JSON.stringify(st).slice(0, 80)}`);
  }
  const base = path.join(HOME, "Treehouse");
  if (fs.existsSync(base)) {
    console.log(`~/Treehouse: ${fs.readdirSync(base).join(", ") || "(empty)"}`);
  }
  const ob = readJson(path.join(TH_HOME, "onboarding.json"));
  console.log(
    `onboarding.json: ${ob ? JSON.stringify({ ...ob, folderRoot: rel(ob.folderRoot) }) : "(none)"}`,
  );
  const journal = path.join(TH_HOME, "onboarding-journal.log");
  if (fs.existsSync(journal)) {
    console.log("journal (last 8):");
    for (const line of fs.readFileSync(journal, "utf8").trim().split("\n").slice(-8)) {
      console.log(`  ${line.replaceAll(HOME, "~").slice(0, 220)}`);
    }
  }
  dialogState();
}

async function down(flags) {
  await stop(MAIN);
  await stop("treehouse.mjs daemon");
  await stop(`nitro dev --port ${API_PORT}`);
  await stop(`nuxt dev --port ${APP_PORT}`);
  const saved = path.join(E2E, "handler-before");
  const restoreTo = fs.existsSync(saved)
    ? fs.readFileSync(saved, "utf8").trim()
    : INSTALLED_BUNDLE_ID;
  if (urlHandler().toLowerCase() === "com.github.electron") {
    console.log(`treehouse:// handler restored → ${urlHandler(restoreTo)}`);
  }
  fs.rmSync(saved, { force: true });
  if (flags.includes("--wipe")) fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log("down");
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  stack: () => stack(),
  launch: () => launch(rest),
  deeplink: () => deeplink(rest[0]),
  dialog: () => dialogState(),
  answer: () => answer(rest[0], rest[1]),
  state: () => state(),
  open: () => openReal(rest[0]),
  quit: async () => (await stop(MAIN), console.log("app quit")),
  down: () => down(rest),
  "url-handler": () => console.log(urlHandler(rest[0])),
};
if (!commands[cmd]) {
  console.log(
    fs
      .readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 23)
      .join("\n"),
  );
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();