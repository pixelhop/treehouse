import { describe, expect, it } from "vite-plus/test";
import { serverAvailable } from "./env";

// The gate that stops a server-backed run from reporting green without a server.
//
// It is tested because it is load-bearing and easy to get subtly wrong: the
// first version checked once, up front, which a server that disappeared for a
// few seconds mid-run walked straight past — every suite in that window skipped,
// and skips look exactly like passes.
//
// A closed port on 127.0.0.1 gives a refused connection, which is the "down"
// case; there is no server involved, so this suite needs none.
const DEAD = "http://127.0.0.1:9";

describe("serverAvailable", () => {
  it("reports a dead endpoint as down when strictness is off", async () => {
    const prev = process.env.REQUIRE_SERVER;
    delete process.env.REQUIRE_SERVER;
    try {
      expect(await serverAvailable(DEAD)).toBe(false);
    } finally {
      if (prev !== undefined) process.env.REQUIRE_SERVER = prev;
    }
  });

  it("throws on a dead endpoint under REQUIRE_SERVER, so the suite fails", async () => {
    const prev = process.env.REQUIRE_SERVER;
    process.env.REQUIRE_SERVER = "1";
    try {
      await expect(serverAvailable(DEAD)).rejects.toThrow(/must run, not skip/);
    } finally {
      if (prev === undefined) delete process.env.REQUIRE_SERVER;
      else process.env.REQUIRE_SERVER = prev;
    }
  });

  it("gives up rather than hanging on a peer that never answers", async () => {
    // A socket that accepts and then says nothing. Without a deadline on the
    // probe this waits forever, and a hung run teaches nobody anything.
    const { createServer } = await import("node:net");
    const server = createServer(() => {
      /* accept, then silence */
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const prev = process.env.REQUIRE_SERVER;
    delete process.env.REQUIRE_SERVER;
    const startedAt = Date.now();
    try {
      expect(await serverAvailable(`http://127.0.0.1:${port}`)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    } finally {
      if (prev !== undefined) process.env.REQUIRE_SERVER = prev;
      server.close();
    }
  }, 20_000);
});