// A manual `treehouse sync` run — exactly what the CLI's one-shot command does,
// with no cross-process coordination with a running daemon.
import { loadConfig } from "../../packages/cli/src/config";
import { runSync } from "../../packages/cli/src/sync";
const root = process.argv[2];
const s = await runSync(root, loadConfig(root));
console.log(
  JSON.stringify({ pushed: s.pushed.length, pulled: s.pulled.length, conflicts: s.conflicts }),
);