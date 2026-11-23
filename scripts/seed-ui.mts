// Seed a known user + workspace with a few files (incl. a conflicted copy) so
// the web UI has something to show. Prints login creds. Needs the API running.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const ORIGIN = process.env.APP_URL ?? "http://localhost:3000";
const stamp = Date.now();
const email = `demo+${stamp}@treehouse.test`;
const password = "treehouse-demo-123";

const jar: string[] = [];
async function http(path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie: jar.join("; ") },
    body: JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(";")[0]);
  return res;
}

await http("/api/auth/sign-up/email", { email, password, name: "Demo User" });
await http("/api/auth/organization/create", { name: "Pixelhop Demo", slug: `pixelhop-${stamp}` });
const agentKey = (await (
  await http("/api/keys", { name: "claude-code", actorType: "agent" })
).json()) as {
  key: string;
  workspaceId: string;
};

const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
  requestInit: { headers: { "x-api-key": agentKey.key } },
});
const agent = new Client({ name: "seed", version: "0" });
await agent.connect(transport);

const write = (path: string, content: string, baseVersion?: number) =>
  agent.callTool({ name: "write_file", arguments: { path, content, baseVersion } });

await write(
  "proposal.md",
  "# Client Proposal\n\n## Scope\n- Discovery workshop\n- Design system\n- Build & launch\n\n## Timeline\n8 weeks, two-week sprints.\n",
);
await write(
  "notes/kickoff.txt",
  "Kickoff call notes:\n- intro the team\n- confirm budget\n- weekly demos\n",
);
await write("README.md", "# Acme Workspace\n\nShared files for the Acme engagement.\n");
// Create a conflict on proposal.md to surface the ⚠ flag in the tree.
await write("proposal.md", "# Client Proposal (v2 by agent)\n", 1); // -> v2
await write("proposal.md", "# Stale human edit\n", 1); // stale -> conflicted copy

await agent.close();

console.log("SEEDED");
console.log("email=" + email);
console.log("password=" + password);
console.log("workspace=" + agentKey.workspaceId);
process.exit(0);