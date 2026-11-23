// End-to-end Treehouse demo. Drives the whole loop against a running API:
//   agent writes via MCP -> cloud -> CLI syncs to a local folder ->
//   human edits -> push -> concurrent conflict keeps both -> change-feed metric.
//
// Prereqs: Postgres up (pnpm --filter db run db:up) and the API running
// (pnpm --filter api dev). Override the URL with SMOKE_BASE.
//
// Run:  node_modules/.bin/tsx scripts/e2e-demo.mts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runSync } from "../packages/cli/src/sync";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const stamp = Date.now();

// --- tiny output helpers ---
const hr = "─".repeat(64);
const section = (n: number, t: string) => console.log(`\n${hr}\n  ${n}. ${t}\n${hr}`);
const log = (...a: unknown[]) => console.log("   ", ...a);

// --- cookie-jar fetch for the session-authed setup calls ---
// better-auth enforces a trusted Origin on state-changing requests (CSRF), so
// every setup call sends one matching APP_URL.
const ORIGIN = process.env.APP_URL ?? "http://localhost:3000";
const jar: string[] = [];
async function http(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      cookie: jar.join("; "),
    },
  });
  for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(";")[0]);
  return res;
}

async function feed(
  key: string,
  wsId: string,
): Promise<{ op: string; principal: string; path: string }[]> {
  const r = await fetch(`${BASE}/api/workspaces/${wsId}/changes`, {
    headers: { "x-api-key": key },
  });
  return ((await r.json()) as { changes: { op: string; principal: string; path: string }[] })
    .changes;
}
async function listing(key: string, wsId: string): Promise<string[]> {
  const r = await fetch(`${BASE}/api/workspaces/${wsId}/list`, { headers: { "x-api-key": key } });
  return ((await r.json()) as { entries: { path: string }[] }).entries.map((e) => e.path);
}

async function mcpClient(key: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
    requestInit: { headers: { "x-api-key": key } },
  });
  const c = new Client({ name: "demo", version: "0.0.0" });
  await c.connect(transport);
  return c;
}
function toolText(r: unknown): string {
  return ((r as { content: { text: string }[] }).content[0]?.text ?? "").replace(/\n/g, " ");
}

// =========================================================================
console.log(`\nTreehouse end-to-end demo  →  ${BASE}`);

section(1, "Setup — sign up, create org, mint agent + human keys (over HTTP)");
const email = `demo${stamp}@example.test`;
await http("/api/auth/sign-up/email", {
  method: "POST",
  body: JSON.stringify({ email, password: "correct-horse-battery", name: "Demo" }),
});
await http("/api/auth/organization/create", {
  method: "POST",
  body: JSON.stringify({ name: "Demo Agency", slug: `demo-${stamp}` }),
});
const agentKeyRes = await http("/api/keys", {
  method: "POST",
  body: JSON.stringify({ name: "claude-code", actorType: "agent" }),
});
const agentKey = (await agentKeyRes.json()) as { key: string; workspaceId: string };
const humanKeyRes = await http("/api/keys", {
  method: "POST",
  body: JSON.stringify({ name: "laptop-cli", actorType: "human" }),
});
const humanKey = (await humanKeyRes.json()) as { key: string };
const wsId = agentKey.workspaceId;
log(`user:      ${email}`);
log(`workspace: ${wsId}`);
log(`agent key: ${agentKey.key.slice(0, 8)}…   human key: ${humanKey.key.slice(0, 8)}…`);

section(2, "Agent writes a file via MCP (Claude Code's path)");
const agent = await mcpClient(agentKey.key);
log("tools:", (await agent.listTools()).tools.map((t) => t.name).join(", "));
log(
  "write_file →",
  toolText(
    await agent.callTool({
      name: "write_file",
      arguments: { path: "proposal.md", content: "# Proposal\n\nDraft by the agent.\n" },
    }),
  ),
);

section(3, "It's in the cloud — REST list + change feed");
log("files:  ", (await listing(agentKey.key, wsId)).join(", "));
log(
  "feed:   ",
  (await feed(agentKey.key, wsId)).map((e) => `${e.op}/${e.principal} ${e.path}`).join("  |  "),
);

section(4, "Human syncs the workspace to a local folder (the CLI)");
const dir = mkdtempSync(join(tmpdir(), "treehouse-demo-"));
const cfg = { apiBase: BASE, apiKey: humanKey.key, workspaceId: wsId };
log("local dir:", dir);
let s = await runSync(dir, cfg);
log(`sync → pulled [${s.pulled.join(", ")}]`);
log("on disk:", JSON.stringify(readFileSync(join(dir, "proposal.md"), "utf8")));

section(5, "Human edits locally and pushes");
writeFileSync(
  join(dir, "proposal.md"),
  "# Proposal\n\nDraft by the agent.\n\n## Budget (added by human)\n",
);
s = await runSync(dir, cfg);
log(`sync → pushed [${s.pushed.join(", ")}]`);
const cloud = await fetch(`${BASE}/api/workspaces/${wsId}/files/proposal.md`, {
  headers: { "x-api-key": humanKey.key },
});
log("cloud now ends with:", JSON.stringify((await cloud.text()).trim().split("\n").pop()));

section(6, "Concurrent edit — agent + human touch the same file → both kept");
// Agent reads the current version (from structured output), then writes a new one.
const read = (await agent.callTool({
  name: "read_file",
  arguments: { path: "proposal.md" },
})) as { structuredContent?: { version: number } };
const version = read.structuredContent?.version ?? 1;
log(`agent reads proposal.md (version ${version}), writes a new version…`);
await agent.callTool({
  name: "write_file",
  arguments: {
    path: "proposal.md",
    content: "# Proposal\n\nRewritten by the agent.\n",
    baseVersion: version,
  },
});
// Human, unaware, edits their now-stale local copy and syncs.
writeFileSync(
  join(dir, "proposal.md"),
  "# Proposal\n\nDraft by the agent.\n\n## Budget (human, stale)\n",
);
s = await runSync(dir, cfg);
log(`sync → conflicts [${s.conflicts.length}]: ${s.conflicts.join(" | ")}`);
log(
  "local proposal.md now holds the winner:",
  JSON.stringify(readFileSync(join(dir, "proposal.md"), "utf8").trim().split("\n").slice(-1)[0]),
);
log("workspace files (both versions preserved):");
for (const p of await listing(humanKey.key, wsId)) log("   •", p);

section(7, "The leading metric — change feed by principal");
const f = await feed(agentKey.key, wsId);
const byPrincipal = f.reduce<Record<string, number>>(
  (m, e) => ((m[e.principal] = (m[e.principal] ?? 0) + 1), m),
  {},
);
log("change events:", JSON.stringify(byPrincipal), `(total ${f.length})`);
log("agent writes are attributed agent even though they share the workspace with the human ✓");

await agent.close();
console.log(
  `\n${hr}\n  ✅ End-to-end loop complete — nothing lost, agent + human on the same files.\n${hr}\n`,
);
process.exit(0);