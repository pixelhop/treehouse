// Run the real sync engine for one root, exactly as the daemon does, but with
// every API call and every reconcile decision traced to stdout as JSON lines.
import { createHash } from "node:crypto";
import { ApiClient } from "../../packages/cli/src/api-client";
import { loadConfig } from "../../packages/cli/src/config";
import { createEngine } from "../../packages/cli/src/engine";

const root = process.argv[2];
if (!root) throw new Error("usage: engine-run.mts <root>");
const cfg = loadConfig(root);

const t0 = Date.now();
function trace(event: string, data: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ t: Date.now() - t0, iso: new Date().toISOString(), event, ...data }),
  );
}
// Bodies over the CLI's streaming threshold are sent as streams, which can't be
// hashed here without consuming them, so those are traced as "(streamed)".
const sha = (b: Uint8Array | AsyncIterable<Uint8Array>) =>
  b instanceof Uint8Array ? createHash("sha256").update(b).digest("hex").slice(0, 8) : "(streamed)";

const modeOf = (opts: any) => ("create" in opts ? "create" : `base:${opts.baseVersion}`);
const sizeOf = (b: Uint8Array | AsyncIterable<Uint8Array>) =>
  b instanceof Uint8Array ? b.length : null;

// Instrumented client: same wire behaviour, full trace of what the CLI decided
// to send and what came back.
class TracedClient extends ApiClient {
  async put(
    path: string,
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
    opts: any,
    contentType: string,
  ): Promise<any> {
    const id = `${path}#${sha(bytes)}`;
    trace("put:send", {
      path,
      mode: modeOf(opts),
      hash: sha(bytes),
      bytes: sizeOf(bytes),
      id,
    });
    const delay = Number(process.env.INV_PUT_DELAY_MS ?? 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const res = await super.put(path, bytes, opts, contentType);
    trace("put:recv", { path, hash: sha(bytes), result: JSON.stringify(res) });
    return res;
  }
  async get(path: string): Promise<any> {
    const res = await super.get(path);
    trace("get", { path, version: res?.version ?? null });
    return res;
  }
  async delete(path: string, baseVersion: number): Promise<any> {
    trace("delete:send", { path, baseVersion });
    const res = await super.delete(path, baseVersion);
    trace("delete:recv", { path, result: res });
    return res;
  }
  async list(): Promise<any> {
    const res = await super.list();
    trace("list", { count: res.length });
    return res;
  }
  async changes(since: number, limit?: number): Promise<any> {
    const res = await super.changes(since, limit);
    if (res.changes.length)
      trace("changes", {
        since,
        head: res.head,
        rows: res.changes.map((c: any) => `${c.op}:${c.path}@${c.version}`),
      });
    return res;
  }
}

const engine = createEngine(root, cfg, {
  api: new TracedClient(cfg),
  pollIntervalMs: Number(process.env.INV_POLL_MS ?? 2000),
  reconcileIntervalMs: Number(process.env.INV_RECONCILE_MS ?? 300000),
  log: (msg) => trace("log", { msg }),
  onState: (s) => trace("state", { state: JSON.stringify(s) }),
});

await engine.start();
trace("started");
process.on("SIGTERM", () => void engine.stop().then(() => process.exit(0)));
process.on("SIGINT", () => void engine.stop().then(() => process.exit(0)));
setInterval(() => {}, 1 << 30);