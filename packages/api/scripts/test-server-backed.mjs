#!/usr/bin/env node
// Run the server-backed route suites, and FAIL when the API is not up — before,
// during, or after.
//
// Nineteen suites sit behind `describe.skipIf(!serverUp)`, which is right for a
// plain `vp test` (no server, no noise) and wrong for the authorization
// boundaries some of them are the only proof of: cookie-vs-API-key on public
// links, folder links refusing to run scripts, workspace scoping. A skip reads
// exactly like a pass, so a run that is meant to prove those has to refuse to be
// silent.
//
// Three guards, because one is not enough:
//   1. a preflight health check, so a run with no server fails immediately;
//   2. REQUIRE_SERVER=1, which makes `serverAvailable()` in `test/env.ts` THROW
//      instead of returning false — checked per suite, so a server that vanishes
//      for part of a run fails those suites rather than letting them skip;
//   3. a post-run health check, because a server that dies mid-run would
//      otherwise let the remaining suites skip their way to green.
//
// Point it at a running API:
//   SMOKE_BASE=http://localhost:3010 node scripts/test-server-backed.mjs
import { spawnSync } from "node:child_process";

// The api package's own dev port. The suites' internal default is the older
// 3001, which is why this passes SMOKE_BASE down explicitly rather than
// letting each file guess.
const BASE = process.env.SMOKE_BASE ?? "http://localhost:3010";

// Suites whose whole point is a boundary that only exists over HTTP. Others are
// server-gated too, but these are the ones that must never quietly skip.
const SUITES = [
  // The gate itself, so a broken guard fails here rather than silently letting
  // everything below it skip.
  "test/server-gate.test.ts",
  "test/shares-routes.test.ts",
  "test/share-public-routes.test.ts",
  "test/share-limits.test.ts",
  "test/files-routes.test.ts",
  // Streaming uploads past the in-memory spool, and byte ranges (206/416).
  "test/files-streaming.test.ts",
  "test/members-routes.test.ts",
  "test/auth-api-key.test.ts",
  // An uploaded workspace icon is served with NO credentials on purpose (an
  // <img>, and an invited non-member's preview, send none). That it stays
  // scoped to the workspace's CURRENT icon is a boundary, not a detail.
  "test/workspace-icon-routes.test.ts",
  // A viewer refused on every write surface, REST and both MCP servers, with the
  // distinct read_only rejection. Then the real sync engine meeting that refusal:
  // what a read-only folder does has to be proved against the real server.
  "test/viewer-routes.test.ts",
  // Read-only and folder-limited keys, including that a key can't escape its scope.
  "test/scoped-keys-routes.test.ts",
  // A restricted folder on every surface, with no bypass for the workspace's
  // owner, and the claim that is the only way past one.
  "test/grants-routes.test.ts",
  "test/cli-sync.test.ts",
];

// Deadlined: a peer that accepts the connection and then says nothing would
// otherwise hang the gate forever, and a hung run reports nothing at all.
const healthy = () =>
  fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok)
    .catch(() => false);

if (!(await healthy())) {
  console.error(
    `\nNo API at ${BASE}.\n` +
      `These suites prove authorization boundaries that only exist over HTTP, so a\n` +
      `run without a server is a failure, not a skip.\n\n` +
      `  pnpm --filter api dev\n` +
      `  SMOKE_BASE=<url> pnpm --filter api run test:server\n`,
  );
  process.exit(1);
}

const res = spawnSync("vp", ["test", ...SUITES], {
  stdio: "inherit",
  env: { ...process.env, SMOKE_BASE: BASE, REQUIRE_SERVER: "1" },
});

// A server that went away mid-run turns every remaining suite into a skip, and
// vitest reports that as success. Checking again is what makes the green mean
// something.
if (!(await healthy())) {
  console.error(
    `\nThe API at ${BASE} stopped responding during the run.\n` +
      `Some suites may have skipped rather than run — treating this as a failure.\n`,
  );
  process.exit(1);
}

process.exit(res.status ?? 1);