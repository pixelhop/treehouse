import { resolve } from "node:path";
import {
  applyPause,
  cmdRelocate,
  cmdLogs,
  cmdRestart,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdUnlink,
  cmdUpdate,
} from "./commands";
import { loadConfig } from "./config";
import { runDaemon } from "./daemon";
import { createEngine, readOnlyLine } from "./engine";
import { positionals } from "./args";
import { runLogin } from "./login";
import { LOG_FILES, type LogName } from "./paths";
import { runSync } from "./sync";

// The shipped binary talks to the production API by default; overridable for
// dev/self-host with --api-base or TREEHOUSE_API_BASE (e.g. a local portless
// origin like https://api.treehouse.localhost).
const DEFAULT_API_BASE = process.env.TREEHOUSE_API_BASE ?? "https://api.trytree.house";

// Baked in by the bundler (esbuild `define`); "dev" when run from source via tsx.
declare const __TREEHOUSE_VERSION__: string;
const VERSION = typeof __TREEHOUSE_VERSION__ !== "undefined" ? __TREEHOUSE_VERSION__ : "dev";

function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// ───────────────────────────────── help ─────────────────────────────────

interface CmdHelp {
  usage: string;
  summary: string;
  flags?: [string, string][];
}

const COMMANDS: Record<string, CmdHelp> = {
  login: {
    usage: "treehouse login [folder]",
    summary: "Connect a folder to a workspace (browser login) and start syncing it.",
    flags: [
      ["--api-base <url>", "API origin to use (default: production)"],
      ["--workspace <id>", "preselect this workspace on the approval page"],
      ["--force", "overwrite an existing .treehouse/config.json"],
      ["--no-open", "don't open the browser automatically"],
      ["--no-start", "connect only; don't start syncing yet"],
    ],
  },
  sync: {
    usage: "treehouse sync [folder] [--watch]",
    summary: "Reconcile a folder with its workspace once, or continuously with --watch.",
    flags: [["--watch", "keep syncing (filesystem watch + change-feed poll)"]],
  },
  start: {
    usage: "treehouse start",
    summary: "Start the background daemon — syncs every linked folder, autostarts on login.",
  },
  stop: { usage: "treehouse stop", summary: "Stop the daemon and disable autostart." },
  restart: {
    usage: "treehouse restart",
    summary: "Restart the daemon (e.g. to pick up a new version after updating).",
  },
  status: { usage: "treehouse status", summary: "Show per-folder sync status." },
  logs: {
    usage: "treehouse logs [daemon|app|updater] [--follow] [--lines <n>]",
    summary: "Print a log (default: the sync daemon's). `app` is the desktop app's own log.",
    flags: [
      ["-f, --follow", "keep printing new lines as they are written"],
      ["-n, --lines <n>", "how many trailing lines to print (default: 100)"],
      ["--path", "print the folder the logs live in (attach it to a bug report)"],
    ],
  },
  update: {
    usage: "treehouse update [--check]",
    summary: "Download & verify the latest version, swap it in, and restart the daemon.",
    flags: [["--check", "report whether an update is available; don't install it"]],
  },
  pause: {
    usage: "treehouse pause [folder]",
    summary: "Pause syncing a folder (keeps it linked; resume anytime).",
  },
  resume: {
    usage: "treehouse resume [folder]",
    summary: "Resume syncing a paused folder.",
  },
  unlink: {
    usage: "treehouse unlink [folder]",
    summary: "Stop syncing a folder (removes it from the daemon's registry).",
  },
  relocate: {
    usage: "treehouse relocate <folder> <new-path>",
    summary: "Move a synced folder to a new path, keeping it connected.",
  },
  version: { usage: "treehouse version", summary: "Print the installed version." },
};

function printGeneralHelp(): void {
  const lines = [
    "treehouse — keep a local folder in sync with your Treehouse workspace.",
    "",
    "usage: treehouse <command> [folder] [flags]",
    "",
    "commands:",
    "  login [folder]     Connect a folder and start syncing",
    "  sync [folder]      Reconcile once (--watch to keep syncing)",
    "  status             Show per-folder sync status",
    "  start / stop       Start or stop the background daemon",
    "  restart            Restart the daemon (after an update)",
    "  pause / resume     Pause or resume syncing a folder",
    // Listed here, not just in COMMANDS: `treehouse help` is how an agent — and
    // most humans — discover what exists at all. Relocation was menubar-only until
    // this command was added, so leaving it out of the listing would have recreated
    // the gap the command was written to close.
    "  relocate <folder>  Move a synced folder to a new path",
    "  update [--check]   Update to the latest version",
    "  logs [--follow]    Show the daemon log (`logs app` for the desktop app)",
    "  unlink [folder]    Stop syncing a folder",
    "  version            Print the installed version",
    "",
    "Run `treehouse <command> --help` for details on a command.",
    "Global flags: --help, -h · --version, -v",
  ];
  console.log(lines.join("\n"));
}

function printCommandHelp(name: string): void {
  const c = COMMANDS[name];
  if (!c) {
    printGeneralHelp();
    return;
  }
  console.log(`treehouse ${name} — ${c.summary}\n`);
  console.log(`usage: ${c.usage}`);
  if (c.flags?.length) {
    const width = Math.max(...c.flags.map(([f]) => f.length));
    console.log("\nflags:");
    for (const [flag, desc] of c.flags) console.log(`  ${flag.padEnd(width)}  ${desc}`);
  }
  console.log("\nGlobal flags: --help, -h · --version, -v");
}

// treehouse <login|link|sync> [dir] [--watch] [--force] [--api-base <url>]
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "sync";

  if (cmd === "version" || args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }

  // help: `treehouse help`, `treehouse --help`, `treehouse <cmd> --help`.
  if (cmd === "help" || args.includes("--help") || args.includes("-h")) {
    const target = COMMANDS[cmd] ? cmd : args.slice(1).find((a) => COMMANDS[a]);
    if (target) printCommandHelp(target);
    else printGeneralHelp();
    return;
  }

  // Daemon lifecycle commands (no directory needed).
  switch (cmd) {
    case "daemon":
      await runDaemon();
      return;
    case "start":
      await cmdStart();
      return;
    case "stop":
      await cmdStop();
      return;
    case "restart":
      await cmdRestart();
      return;
    case "status":
      await cmdStatus();
      return;
    case "logs": {
      const name = args[1] && !args[1].startsWith("-") ? args[1] : "daemon";
      if (!Object.hasOwn(LOG_FILES, name)) {
        console.error(
          `Unknown log: ${name} (expected one of: ${Object.keys(LOG_FILES).join(", ")})\n`,
        );
        printCommandHelp("logs");
        process.exit(1);
      }
      const lines = Number.parseInt(
        flagValue(args, "--lines") ?? flagValue(args, "-n") ?? "100",
        10,
      );
      await cmdLogs({
        name: name as LogName,
        lines: Number.isInteger(lines) && lines > 0 ? lines : 100,
        follow: args.includes("--follow") || args.includes("-f"),
        path: args.includes("--path"),
      });
      return;
    }
    case "update":
      await cmdUpdate({ check: args.includes("--check") });
      return;
  }

  if (!["sync", "login", "link", "unlink", "pause", "resume", "relocate"].includes(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    printGeneralHelp();
    process.exit(1);
  }
  // Agents write these commands too, and put flags wherever they like:
  // `login --api-base <url> <folder>` must not sync into a folder named after the URL.
  const positional = positionals(args.slice(1))[0];
  const root = resolve(positional ?? ".");

  // Move a linked folder, keeping it connected — same parity rule as pause/resume.
  // Takes TWO positionals, so it is handled before the single-root commands below.
  if (cmd === "relocate") {
    const paths = positionals(args.slice(1));
    if (paths.length < 2) {
      console.error("Usage: treehouse relocate <folder> <new-path>\n");
      printCommandHelp("relocate");
      process.exit(1);
    }
    await cmdRelocate(resolve(paths[0] as string), resolve(paths[1] as string));
    return;
  }

  // Pause/resume a single linked folder (agent-native parity with the app's tray:
  // any action a user can take from the menubar, an agent can take from the CLI).
  if (cmd === "pause" || cmd === "resume") {
    const paused = cmd === "pause";
    await applyPause(root, paused);
    console.log(`${paused ? "Paused" : "Resumed"} ${root}`);
    return;
  }

  // login / link: device-code onboarding, writes .treehouse/config.json.
  if (cmd === "login" || cmd === "link") {
    await runLogin({
      apiBase: flagValue(args, "--api-base") ?? DEFAULT_API_BASE,
      root,
      force: args.includes("--force"),
      open: !args.includes("--no-open"),
      start: !args.includes("--no-start"), // auto-start syncing after connecting
      workspaceId: flagValue(args, "--workspace"),
    });
    return;
  }

  if (cmd === "unlink") {
    await cmdUnlink(root);
    return;
  }

  const watch = args.includes("--watch");
  const cfg = loadConfig(root);

  if (watch) {
    // Incremental, near-real-time engine: bootstrap once, then fs-watch (local
    // ->cloud) + change-feed poll (cloud->local), with a periodic full reconcile.
    const engine = createEngine(root, cfg, { log: (m) => console.log(m) });
    const shutdown = () => {
      void engine.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await engine.start();
    // Keep the process alive; the engine runs until a signal stops it.
    await new Promise(() => {});
    return;
  }

  // One-shot full reconcile.
  const s = await runSync(root, cfg);
  const parts: string[] = [];
  if (s.pulled.length) parts.push(`↓ ${s.pulled.length}`);
  if (s.pushed.length) parts.push(`↑ ${s.pushed.length}`);
  if (s.deleted.length) parts.push(`✗ ${s.deleted.length}`);
  console.log(parts.length ? `synced  ${parts.join("  ")}` : "up to date");
  if (s.conflicts.length) {
    console.log(`⚠ ${s.conflicts.length} conflict(s) — both versions kept:`);
    for (const c of s.conflicts) console.log(`   ${c}`);
  }
  if (s.refusedDeletes.length) {
    console.log(
      `⚠ kept ${s.refusedDeletes.length} local file(s) the remote was missing — re-uploaded instead of deleting (looks like a reset or wrong workspace).`,
    );
  }
  for (const n of s.readOnly) console.log(`⚠ ${readOnlyLine(n)}`);
  if (s.oversize.length) {
    console.log(`⚠ skipped ${s.oversize.length} file(s) over the upload size limit:`);
    for (const o of s.oversize) console.log(`   ${o}`);
  }
  // A per-path failure no longer aborts the pass (the rest of the workspace
  // syncs and is baselined), but a one-shot run still has to report it as a
  // failure so a script or CI step doesn't read a partial sync as a clean one.
  if (s.failed.length) {
    console.error(`⚠ ${s.failed.length} file(s) failed — rerun to retry:`);
    for (const f of s.failed) console.error(`   ${f.path}: ${f.reason}`);
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});