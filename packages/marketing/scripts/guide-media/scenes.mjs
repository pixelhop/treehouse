#!/usr/bin/env node
/**
 * Stage the scenes the guide videos show, on top of the docs-screenshots demo
 * workspace (run ../docs-screenshots/seed.mjs first). Everything goes through
 * the public API, signed in as Sam, with agent keys this script creates.
 *
 *   WORKSPACE_ID=<id from seed.mjs> node scenes.mjs <scene>
 *
 * Scenes, in the order README.md uses them:
 *   keys           create the claude-code and inbox-filer agent keys (writes .keys.json)
 *   agent-mistake  claude-code rewrites two files badly and archives a meeting note
 *   inbox          Sam drops three notes in Inbox/, then inbox-filer files and links them
 *   approve        approve the next pending CLI login (for the terminal clip)
 *
 * Against a local stack only - never a real deployment.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const API = process.env.API_URL ?? "http://localhost:3110";
const APP = process.env.APP_URL ?? "http://localhost:3100";
const WS = process.env.WORKSPACE_ID;
const DB = process.env.DATABASE_NAME ?? "treehouse_docs_screens";
const KEYS = new URL("./.keys.json", import.meta.url);
if (!WS) throw new Error("Set WORKSPACE_ID (printed by seed.mjs)");

const jar = new Map();

/** Sam's session cookie, or an agent's key. */
function credentials(key) {
  if (key) return { "x-api-key": key };
  return { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
}

function keepCookies(res) {
  for (const cookie of res.headers.getSetCookie?.() ?? []) {
    const [pair] = cookie.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

/** JSON bodies are encoded; `raw` sends a string as it is, with the caller's content type. */
function request(method, body, raw, headers) {
  if (body === undefined) return { method, headers };
  if (raw) return { method, headers, body };
  return {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function call(method, path, { body, key, headers = {}, raw = false } = {}) {
  const init = request(method, body, raw, { Origin: APP, ...headers, ...credentials(key) });
  const res = await fetch(API + path, init);
  keepCookies(res);
  const text = await res.text();
  if (res.status >= 400) {
    throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return { headers: res.headers, data: text ? JSON.parse(text) : null };
}
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const version = async (path, key) =>
  Number(
    (await call("GET", `/api/workspaces/${WS}/files/${enc(path)}`, { key })).headers.get(
      "x-treehouse-version",
    ),
  );
async function write(path, content, { key, base } = {}) {
  const headers = {
    "Content-Type": "text/markdown",
    ...(base ? { "If-Match": `"${base}"` } : { "If-None-Match": "*" }),
  };
  await call("PUT", `/api/workspaces/${WS}/files/${enc(path)}`, {
    key,
    raw: true,
    body: content,
    headers,
  });
}
const move = (from, to, key) =>
  call("POST", `/api/workspaces/${WS}/move`, { key, body: { from, to } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = () => JSON.parse(readFileSync(KEYS, "utf8"));

await call("POST", "/api/auth/sign-in/email", {
  body: { email: "sam@example.com", password: process.env.DEMO_PASSWORD ?? "treehouse-demo-2026" },
});

const scenes = {
  async keys() {
    const mint = async (name) =>
      (await call("POST", "/api/keys", { body: { name, actorType: "agent" } })).data.key;
    writeFileSync(
      KEYS,
      JSON.stringify({ claude: await mint("claude-code"), filer: await mint("inbox-filer") }),
    );
  },

  async "agent-mistake"() {
    const { claude } = keys();
    const tone = "Brand/tone-of-voice.md";
    await write(
      tone,
      `---\ntitle: Tone of voice\n---\n\n# OUR VOICE\n\nWe are BOLD. We are DISRUPTIVE. Every sentence should end with an exclamation mark!\n\n- Always say "synergy"!\n- Use as many adjectives as possible!\n`,
      { key: claude, base: await version(tone, claude) },
    );
    await sleep(300);
    const pricing = "Decisions/2026-09-12-studio-pricing.md";
    await write(pricing, `---\ntitle: Studio pricing\n---\n\nStudio tier: £29 a month.\n`, {
      key: claude,
      base: await version(pricing, claude),
    });
    await sleep(300);
    await move(
      "Meetings/2026-09-24-weekly-studio.md",
      "Archive/2026-09-24-weekly-studio.md",
      claude,
    );
  },

  async inbox() {
    const { filer } = keys();
    const captures = {
      "Inbox/voice note - bakery holiday idea.md": `Recorded walking back from Bluebird.\n\nWhat if the holiday campaign is a countdown of 12 loaves, one a day, each with a short video of the baker? Ask Maya if they can bake ahead.\n`,
      "Inbox/northwind call.md": `Quick call with Dana at Northwind.\n\n- They loved the October report.\n- Want the same format monthly, first one due 4 November.\n- Asked whether we can add a trail-usage map.\n`,
      "Inbox/why small studios win.md": `https://example.com/why-small-studios-win\n\nGood bit on keeping client folders public-facing from day one. Worth a look before the relaunch case studies.\n`,
    };
    for (const [path, body] of Object.entries(captures)) {
      await write(path, body);
      await sleep(300);
    }
    const filing = [
      [
        "Inbox/voice note - bakery holiday idea.md",
        "Clients/Bluebird Bakery/Notes/2026-09-30-holiday-countdown-idea.md",
        `---\ntitle: Holiday countdown idea\ndate: 2026-09-30\nsource: voice note\n---\n\nA holiday campaign as a countdown of 12 loaves, one a day, each with a short video of the baker.\n\n**Open question:** can Maya bake ahead?\n\n## Related\n\n- [[2026-09-29-call]] (first call, where they asked for something seasonal)\n- [[bakery-behind-the-scenes]] (video format we could reuse)\n`,
      ],
      [
        "Inbox/northwind call.md",
        "Clients/Northwind/Notes/2026-09-30-monthly-report-call.md",
        `---\ntitle: Call with Dana about monthly reports\ndate: 2026-09-30\n---\n\n- They loved the October report.\n- Same format monthly. First one due **4 November**.\n- Asked for a trail-usage map. Not in the current scope.\n\n## Related\n\n- [[2026-09-29-feedback]]\n- [[october-report.html]]\n`,
      ],
      [
        "Inbox/why small studios win.md",
        "Projects/Website relaunch/reading-why-small-studios-win.md",
        `---\ntitle: "Reading: why small studios win"\nsource: https://example.com/why-small-studios-win\n---\n\nKeep client folders public-facing from day one. Worth a look before writing the relaunch case studies.\n\n## Related\n\n- [[case-studies]]\n`,
      ],
    ];
    for (const [from, to, body] of filing) {
      await move(from, to, filer);
      await sleep(250);
      await write(to, body, { key: filer, base: await version(to, filer) });
      await sleep(250);
    }
  },

  async approve() {
    const q = `select "userCode" from device_authorization where status='pending' order by "createdAt" desc limit 1`;
    for (let i = 0; i < 240; i++) {
      const code = execFileSync("docker", [
        "exec",
        "db-postgres-1",
        "psql",
        "-U",
        "postgres",
        "-d",
        DB,
        "-tAc",
        q,
      ])
        .toString()
        .trim();
      if (code) {
        await sleep(2500); // long enough for the clip to show the waiting state
        await call("POST", "/api/device/approve", { body: { user_code: code, workspaceId: WS } });
        return;
      }
      await sleep(500);
    }
    throw new Error("No CLI login to approve");
  },
};

const scene = scenes[process.argv[2]];
if (!scene) throw new Error(`Unknown scene. One of: ${Object.keys(scenes).join(", ")}`);
await scene();
console.log(`${process.argv[2]}: done`);