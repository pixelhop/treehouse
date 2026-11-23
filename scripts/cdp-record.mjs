#!/usr/bin/env node
// Record any CDP page target — the desktop app's window or a browser tab — to MP4.
//
//   node scripts/cdp-record.mjs --port 9333 --out .e2e/video/route-1.mp4 [--match 127.0.0.1:3100]
//
// Stop it by touching `<out>.stop` (or SIGINT/SIGTERM). While it runs, write a line of
// text to `<out>.caption` to show it as a narration banner at the bottom of the page
// (empty file = hide). Captions are how a recording shows what happened in places the
// screencast can't see, like a native folder picker answered through the harness.
//
// Why not `agent-browser record`: it records by creating a new browser context, which
// Electron refuses ("Failed to create browser context"). The DevTools screencast works
// on any page target, Electron included, and survives navigations.
//
// Frames arrive only when the page repaints, each with a timestamp, so the MP4 is
// assembled with per-frame durations: idle stretches play at real speed rather than
// being skipped.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(opt("port", 9333));
const out = path.resolve(opt("out", ".e2e/video/recording.mp4"));
const match = opt("match", "");
const framesDir = `${out}.frames`;
const stopFile = `${out}.stop`;
const captionFile = `${out}.caption`;

fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });
fs.rmSync(stopFile, { force: true });
fs.writeFileSync(captionFile, "");

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(
  (t) => t.type === "page" && !t.url.startsWith("devtools://") && t.url.includes(match),
);
if (!target) {
  console.error(`no page target on :${port}${match ? ` matching ${match}` : ""}`);
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

const frames = []; // { file, ts }
let caption = "";

/** The banner, injected into whatever document is current. Re-run after each load. */
function captionScript(text) {
  return `(() => {
    // Dev-server chrome (the Nuxt DevTools badge) is not part of the product — keep
    // it out of the evidence.
    if (!document.getElementById("__e2e_hide")) {
      const style = document.createElement("style");
      style.id = "__e2e_hide";
      style.textContent = "#nuxt-devtools-container, nuxt-devtools-frame, .nuxt-devtools-panel { display: none !important; }";
      document.documentElement.appendChild(style);
    }
    let el = document.getElementById("__e2e_caption");
    const t = ${JSON.stringify(text)};
    if (!t) { el?.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "__e2e_caption";
      Object.assign(el.style, {
        position: "fixed", left: "50%", top: "18px", transform: "translateX(-50%)",
        zIndex: "2147483647", background: "rgba(23, 38, 30, 0.92)", color: "#fff",
        font: "600 15px/1.4 -apple-system, system-ui, sans-serif", padding: "10px 18px",
        borderRadius: "12px", maxWidth: "80%", textAlign: "center", pointerEvents: "none",
        boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
      });
      document.documentElement.appendChild(el);
    }
    el.textContent = t;
  })()`;
}
const showCaption = () =>
  send("Runtime.evaluate", { expression: captionScript(caption) }).catch(() => {});

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "Page.screencastFrame") {
    const { data, metadata, sessionId } = msg.params;
    const file = path.join(framesDir, `${String(frames.length).padStart(6, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, ts: metadata.timestamp ?? Date.now() / 1000 });
    void send("Page.screencastFrameAck", { sessionId });
  }
  // A new document drops the banner (and the badge-hiding style) — put them back.
  if (msg.method === "Page.loadEventFired" || msg.method === "Page.domContentEventFired") {
    void showCaption();
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
await send("Page.enable");
await send("Runtime.enable");
await showCaption();
await send("Page.startScreencast", {
  format: "jpeg",
  quality: 85,
  maxWidth: 1600,
  maxHeight: 1100,
});
console.log(`recording ${target.url} → ${path.relative(process.cwd(), out)}`);

let stopping = false;
const poll = setInterval(() => {
  if (fs.existsSync(stopFile)) void stop();
  let next = "";
  try {
    next = fs.readFileSync(captionFile, "utf8").trim();
  } catch {
    // missing file — keep the current caption
    next = caption;
  }
  if (next !== caption) {
    caption = next;
    void showCaption();
  }
}, 150);
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(poll);
  const endTs = Date.now() / 1000;
  caption = "";
  await showCaption();
  await send("Page.stopScreencast").catch(() => {});
  ws.close();
  if (frames.length === 0) {
    console.error("no frames captured");
    process.exit(1);
  }
  // concat demuxer: each frame shown until the next one arrived; the last until stop.
  const lines = [];
  frames.forEach((f, i) => {
    const until = i + 1 < frames.length ? frames[i + 1].ts : Math.max(endTs, f.ts + 0.5);
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.01, until - f.ts).toFixed(3)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`); // concat quirk: repeat the last
  const list = path.join(framesDir, "list.txt");
  fs.writeFileSync(list, `${lines.join("\n")}\n`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-movflags",
      "+faststart",
      out,
    ],
    { stdio: "inherit" },
  );
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.rmSync(stopFile, { force: true });
  fs.rmSync(captionFile, { force: true });
  console.log(`saved ${path.relative(process.cwd(), out)} (${frames.length} frames)`);
  process.exit(0);
}