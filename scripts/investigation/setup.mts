// Provision a disposable workspace + human CLI key against a local API.
// Prints one line of JSON: { base, apiKey, agentKey, workspaceId }
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3010";
const ORIGIN = process.env.APP_URL ?? "http://localhost:3000";
const root = process.argv[2];
if (!root) throw new Error("usage: setup.mts <root>");

const jar: string[] = [];
async function http(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", origin: ORIGIN, cookie: jar.join("; ") },
  });
  for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(";")[0]);
  return res;
}

const stamp = Date.now();
await http("/api/auth/sign-up/email", {
  method: "POST",
  body: JSON.stringify({
    email: `inv${stamp}@example.test`,
    password: "correct-horse-battery",
    name: "Inv",
  }),
});
await http("/api/auth/organization/create", {
  method: "POST",
  body: JSON.stringify({ name: "Inv", slug: `inv-${stamp}` }),
});
const ws = (await (await http("/api/workspace")).json()) as { id: string };
const human = (await (
  await http("/api/keys", {
    method: "POST",
    body: JSON.stringify({ name: "laptop-cli", actorType: "human", workspaceId: ws.id }),
  })
).json()) as { key: string; workspaceId: string };
const agent = (await (
  await http("/api/keys", {
    method: "POST",
    body: JSON.stringify({ name: "claude", actorType: "agent", workspaceId: ws.id }),
  })
).json()) as { key: string };

mkdirSync(`${root}/.treehouse`, { recursive: true });
writeFileSync(
  `${root}/.treehouse/config.json`,
  `${JSON.stringify({ apiBase: BASE, apiKey: human.key, workspaceId: ws.id }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(
  JSON.stringify({ base: BASE, apiKey: human.key, agentKey: agent.key, workspaceId: ws.id }),
);