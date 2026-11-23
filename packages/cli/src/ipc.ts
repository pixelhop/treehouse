import { chmodSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { sockPath } from "./paths";

// Daemon control channel: newline-delimited JSON over a Unix socket (a named
// pipe on Windows). The socket is owner-only (0600) on POSIX. `status`/`stop`/
// `reload` requests flow over it; when the daemon is down, sendIpc resolves null
// and callers fall back to reading state off disk.
//
// links.json and this protocol are cross-version contracts between independently
// updated app/CLI installs. Every response carries `protocol` so a client can
// detect skew; both sides tolerate unknown fields (extra keys are ignored, never
// rejected) so a newer peer's additions never break an older one.

export const IPC_PROTOCOL_VERSION = 1;

export interface IpcRequest {
  /** Known verbs are status/stop/reload; an unknown verb gets a structured error
   * rather than a hang, so a newer client probing an older daemon fails cleanly. */
  cmd: string;
  /** Optional client protocol version; the daemon tolerates its absence. */
  protocol?: number;
  // Tolerate unknown fields from newer clients.
  [key: string]: unknown;
}

/** Every daemon response carries `ok` + `protocol`; other fields are per-verb. */
export interface IpcResponse {
  ok: boolean;
  protocol: number;
  [key: string]: unknown;
}

export type IpcHandler = (req: IpcRequest) => Promise<unknown>;

export function serveIpc(handler: IpcHandler): { close: () => Promise<void> } {
  const path = sockPath();
  if (process.platform !== "win32") rmSync(path, { force: true }); // clear a stale socket

  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      void (async () => {
        let res: unknown;
        try {
          const raw = await handler(JSON.parse(line) as IpcRequest);
          // Stamp the protocol version onto every object response so clients can
          // detect version skew; a non-object response is passed through as-is.
          // The stamp is applied AFTER the spread so it describes this daemon's
          // wire protocol, not whatever a handler happened to put in the payload.
          res =
            raw && typeof raw === "object"
              ? { ...(raw as Record<string, unknown>), protocol: IPC_PROTOCOL_VERSION }
              : raw;
        } catch (e) {
          res = {
            ok: false,
            protocol: IPC_PROTOCOL_VERSION,
            code: "handler_error",
            // A handler may throw a non-Error; `(e as Error).message` would make
            // the error field `undefined` on exactly the responses that need it.
            error: e instanceof Error ? e.message : String(e),
          };
        }
        sock.end(`${JSON.stringify(res)}\n`);
      })();
    });
    sock.on("error", () => sock.destroy());
  });

  server.listen(path, () => {
    if (process.platform !== "win32") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort; the socket lives in the 0700 app dir already
      }
    }
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Send a request to a running daemon. Resolves null if it isn't reachable. */
export function sendIpc(req: IpcRequest, timeoutMs = 2500): Promise<unknown> {
  return new Promise((resolve) => {
    const sock = connect(sockPath());
    let buf = "";
    let settled = false;
    const done = (v: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\n")) {
        try {
          done(JSON.parse(buf.trim()));
        } catch {
          done(null);
        }
      }
    });
    sock.on("error", () => done(null)); // daemon not running / socket gone
  });
}