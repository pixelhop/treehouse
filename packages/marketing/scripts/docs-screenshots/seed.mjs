#!/usr/bin/env node
/**
 * Seed a demo workspace for the docs screenshots.
 *
 * Builds "Acme Studio", a small design studio's workspace, entirely through the
 * public API so the result looks like real use: a person (Sam) signs up and
 * writes some files in the browser session, two agent keys write and file the
 * rest, a teammate (Priya) joins through an invite link, review comments go
 * back and forth, one write collides into a conflicted copy, and a client
 * folder is shared publicly. Everything is fictional.
 *
 * Usage (against a local stack - never a real deployment):
 *   API_URL=http://localhost:3110 APP_URL=http://localhost:3100 \
 *     node packages/marketing/scripts/docs-screenshots/seed.mjs
 *
 * Prints the ids, keys and share URL the capture step needs as JSON.
 * See ./README.md for the whole process.
 */

const API = process.env.API_URL ?? "http://localhost:3110";
const APP = process.env.APP_URL ?? "http://localhost:3100";
const PASSWORD = process.env.DEMO_PASSWORD ?? "treehouse-demo-2026";

/** A tiny cookie jar per person, enough for better-auth's session cookie. */
function session() {
  const jar = new Map();
  return {
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    store(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
  };
}

async function call(who, method, path, { body, headers = {}, raw = false } = {}) {
  const h = { Origin: APP, ...headers };
  if (who.key) h["x-api-key"] = who.key;
  if (who.jar) h.Cookie = who.jar.header();
  let payload = body;
  if (body !== undefined && !raw && typeof body !== "string" && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  const init = { method, headers: h };
  if (payload !== undefined) init.body = payload;
  const res = await fetch(`${API}${path}`, init);
  who.jar?.store(res);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

async function must(promise, label) {
  const res = await promise;
  if (res.status >= 400)
    throw new Error(`${label}: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  return res;
}

async function signUp(name, email) {
  const person = { jar: session() };
  await must(
    call(person, "POST", "/api/auth/sign-up/email", { body: { name, email, password: PASSWORD } }),
    `sign up ${email}`,
  );
  return person;
}

const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

/** Write a file; returns its new version. `base` is the version it builds on. */
async function write(who, ws, path, content, base) {
  const headers = { "Content-Type": contentType(path) };
  if (base) headers["If-Match"] = `"${base}"`;
  else headers["If-None-Match"] = "*";
  const res = await call(who, "PUT", `/api/workspaces/${ws}/files/${enc(path)}`, {
    body: typeof content === "string" ? content : content,
    headers,
    raw: true,
  });
  if (res.status >= 400 && res.status !== 412) {
    throw new Error(`write ${path}: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

function contentType(path) {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  return "text/plain";
}

async function version(who, ws, path) {
  const res = await must(
    call(who, "GET", `/api/workspaces/${ws}/files/${enc(path)}`),
    `read ${path}`,
  );
  return Number(res.headers.get("x-treehouse-version"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

const sam = await signUp("Sam Rivers", "sam@example.com");
const { data: wsList } = await must(call(sam, "GET", "/api/workspaces"), "list workspaces");
const ws = (wsList.workspaces ?? wsList)[0].id;

await must(
  call(sam, "PATCH", `/api/workspaces/${ws}`, {
    body: { name: "Acme Studio", icon: "🌳", color: "emerald" },
  }),
  "customise workspace",
);

const mintKey = async (name) =>
  (
    await must(
      call(sam, "POST", "/api/keys", { body: { name, actorType: "agent" } }),
      `key ${name}`,
    )
  ).data.key;
const claude = { key: await mintKey("claude-code") };
const filer = { key: await mintKey("inbox-filer") };

// --- The structure the setup agent built -----------------------------------

const files = await import("./seed-content.mjs");
for (const [path, content] of Object.entries(files.AGENT_FILES)) {
  await write(claude, ws, path, content);
}
// The seeded starter README and AGENTS.md are replaced, as setup would.
await write(claude, ws, "README.md", files.ROOT_README, await version(claude, ws, "README.md"));
await write(claude, ws, "AGENTS.md", files.ROOT_AGENTS, await version(claude, ws, "AGENTS.md"));

// --- Sam's own writing in the browser --------------------------------------

for (const [path, content] of Object.entries(files.SAM_FILES)) {
  await write(sam, ws, path, content);
}

// --- A draft that goes through review --------------------------------------

const draft = "Projects/Website relaunch/launch-announcement.md";
let v = (await write(claude, ws, draft, files.ANNOUNCEMENT_V1)).version;
v = (await write(sam, ws, draft, files.ANNOUNCEMENT_V2, v)).version;

const thread = async (who, quote, body) =>
  (
    await must(
      call(who, "POST", `/api/workspaces/${ws}/comments`, {
        body: { path: draft, kind: "range", quote, body, baseVersion: v },
      }),
      `comment on "${quote}"`,
    )
  ).data.thread;

const t1 = await thread(
  sam,
  "We're thrilled to announce",
  "Let's not open with 'thrilled'. Lead with what changed for the reader.",
);
const t2 = await thread(
  sam,
  "Pricing starts at £49 a month.",
  "Can we check this with Priya before it goes out? I think the Studio tier moved.",
);

v = (await write(claude, ws, draft, files.ANNOUNCEMENT_V3, v)).version;
await must(
  call(claude, "POST", `/api/workspaces/${ws}/comments/${t1.id}/replies`, {
    body: {
      body: "Rewrote the opening to lead with the new booking flow and dropped 'thrilled'. The first line is now: \"You can now book a project with us in three clicks.\"",
      dedupeKey: "t1-reply-1",
    },
  }),
  "agent reply",
);
await must(
  call(claude, "PUT", `/api/workspaces/${ws}/comments/${t1.id}/resolved`, {
    body: { resolved: true },
  }),
  "agent resolve",
);
await must(
  call(claude, "POST", `/api/workspaces/${ws}/comments/${t2.id}/replies`, {
    body: {
      body: "I couldn't find the current Studio price in Decisions/ or Brand/, so I've left this open for Priya rather than guessing.",
      dedupeKey: "t2-reply-1",
    },
  }),
  "agent reply 2",
);

// --- Priya joins through an invite link ------------------------------------

const invite = await must(
  call(sam, "POST", "/api/invites", { body: { workspaceId: ws, expiresInDays: 7 } }),
  "create invite",
);
const priya = await signUp("Priya Shah", "priya@example.com");
await must(call(priya, "POST", `/api/invites/${invite.data.token}/accept`), "accept invite");
await must(
  call(priya, "POST", `/api/workspaces/${ws}/comments/${t2.id}/replies`, {
    body: { body: "It's £59 now. Decision is in Decisions/2026-09-12-studio-pricing.md." },
  }),
  "priya reply",
);
await write(priya, ws, "Meetings/2026-09-29-weekly-studio.md", files.PRIYA_MEETING);

// --- The inbox filer does its morning run ----------------------------------

for (const [from, to] of files.INBOX_MOVES) {
  await must(
    call(filer, "POST", `/api/workspaces/${ws}/move`, { body: { from, to } }),
    `move ${from}`,
  );
}

// --- A collision: Sam and the agent both update the project status ---------

const status = "Projects/Website relaunch/README.md";
const before = await version(claude, ws, status);
await write(sam, ws, status, files.STATUS_SAM, before);
await sleep(50);
await write(claude, ws, status, files.STATUS_AGENT, before); // stale -> conflicted copy

// --- History on the tone of voice page -------------------------------------

const tone = "Brand/tone-of-voice.md";
let tv = await version(claude, ws, tone);
tv = (await write(sam, ws, tone, files.TONE_V2, tv)).version;
await write(claude, ws, tone, files.TONE_V3, tv);

// --- Sharing and privacy ----------------------------------------------------

const share = await must(
  call(sam, "POST", `/api/workspaces/${ws}/shares`, {
    body: { path: "Clients/Northwind/Deliverables", kind: "folder", access: "public" },
  }),
  "public share",
);
await must(
  call(sam, "PUT", `/api/workspaces/${ws}/node-private`, {
    body: { path: "Sam's drafts", kind: "folder", private: true },
  }),
  "private folder",
);

console.log(
  JSON.stringify(
    {
      workspaceId: ws,
      app: APP,
      api: API,
      sam: { email: "sam@example.com", password: PASSWORD },
      priya: { email: "priya@example.com", password: PASSWORD },
      shareToken: share.data.share?.token,
      shareUrl: share.data.share?.token ? `${APP}/s/${share.data.share.token}` : null,
      inviteUrl: invite.data.url,
    },
    null,
    2,
  ),
);