import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { IPC_PROTOCOL_VERSION, sendIpc, serveIpc } from "../src/ipc";

const freshHome = () => {
  process.env.TREEHOUSE_HOME = mkdtempSync(join(tmpdir(), "th-ipc-"));
};

describe("ipc", () => {
  afterEach(() => {
    delete process.env.TREEHOUSE_HOME;
  });

  it("round-trips a request to the served handler", async () => {
    freshHome();
    const server = serveIpc((req) => Promise.resolve({ ok: true, echo: req.cmd }));
    await new Promise((r) => setTimeout(r, 50)); // let it bind
    try {
      // The response now also carries the stamped `protocol` field (U2).
      expect(await sendIpc({ cmd: "status" })).toMatchObject({ ok: true, echo: "status" });
    } finally {
      await server.close();
    }
  });

  it("resolves null when nothing is listening", async () => {
    freshHome();
    expect(await sendIpc({ cmd: "status" }, 400)).toBeNull();
  });

  it("stamps the protocol version onto every object response (U2)", async () => {
    freshHome();
    const server = serveIpc(() => Promise.resolve({ ok: true, dirs: [] }));
    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = (await sendIpc({ cmd: "status" })) as { protocol: number; ok: boolean };
      expect(res.protocol).toBe(IPC_PROTOCOL_VERSION);
      expect(res.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("the stamp describes the daemon, not a handler payload (U2)", async () => {
    freshHome();
    // A handler returning its own `protocol` must not win: clients read this
    // field to detect skew, so it has to report the daemon's wire version.
    const server = serveIpc(() => Promise.resolve({ ok: true, protocol: 99 }));
    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = (await sendIpc({ cmd: "status" })) as { protocol: number };
      expect(res.protocol).toBe(IPC_PROTOCOL_VERSION);
    } finally {
      await server.close();
    }
  });

  it("reports a handler that throws a non-Error without losing the message", async () => {
    freshHome();
    const server = serveIpc(() => Promise.reject("boom"));
    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = (await sendIpc({ cmd: "status" })) as {
        ok: boolean;
        code: string;
        error: string;
      };
      expect(res.ok).toBe(false);
      expect(res.code).toBe("handler_error");
      expect(res.error).toBe("boom"); // not `undefined` from `(e as Error).message`
    } finally {
      await server.close();
    }
  });

  it("tolerates unknown request fields from a newer client (U2)", async () => {
    freshHome();
    const server = serveIpc((req) => Promise.resolve({ ok: true, echo: req.cmd }));
    await new Promise((r) => setTimeout(r, 50));
    try {
      // Extra fields a future client might add must not break the daemon.
      const res = (await sendIpc({ cmd: "status", protocol: 99, future: "x" } as never)) as {
        ok: boolean;
        echo: string;
      };
      expect(res.ok).toBe(true);
      expect(res.echo).toBe("status");
    } finally {
      await server.close();
    }
  });

  it("returns a structured error for an unknown command, not a hang (U2)", async () => {
    freshHome();
    // Mirror the daemon's own unknown-verb handling.
    const server = serveIpc((req) =>
      req.cmd === "status"
        ? Promise.resolve({ ok: true })
        : Promise.resolve({
            ok: false,
            code: "unknown_command",
            error: `unknown command: ${req.cmd}`,
          }),
    );
    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = (await sendIpc({ cmd: "bogus" }, 1000)) as {
        ok: boolean;
        code: string;
        protocol: number;
      };
      expect(res).not.toBeNull();
      expect(res.ok).toBe(false);
      expect(res.code).toBe("unknown_command");
      expect(res.protocol).toBe(IPC_PROTOCOL_VERSION);
    } finally {
      await server.close();
    }
  });
});