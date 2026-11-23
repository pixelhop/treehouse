import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, createRouter, defineEventHandler, toNodeListener } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// The allowlist is read when the middleware module loads, so set it first.
process.env.APP_URL = "https://app.example.com";
const cors = (await import("../server/middleware/cors")).default;

let server: Server;
let base: string;

beforeAll(async () => {
  const router = createRouter()
    .get(
      "/api/plans",
      defineEventHandler(() => ({ available: true, plans: [] })),
    )
    .get(
      "/api/workspace",
      defineEventHandler(() => ({ ok: true })),
    )
    .post(
      "/api/mcp",
      defineEventHandler(() => ({ ok: true })),
    )
    .get(
      "/.well-known/oauth-protected-resource/api/mcp",
      defineEventHandler(() => ({ resource: "x" })),
    );
  const app = createApp();
  app.use(cors);
  app.use(router);
  server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("cors", () => {
  it("gives the app credentialed access to its own origin", async () => {
    const res = await fetch(`${base}/api/workspace`, {
      headers: { origin: "https://app.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("lets any site read the public price list, without cookies", async () => {
    // The marketing site shows the prices checkout charges, read from here.
    const res = await fetch(`${base}/api/plans?x=1`, {
      headers: { origin: "https://trytree.house" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("gives other origins nothing anywhere else", async () => {
    const res = await fetch(`${base}/api/workspace`, {
      headers: { origin: "https://trytree.house" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("lets a browser MCP client reach the OAuth + MCP surface, without cookies", async () => {
    const mcp = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { origin: "https://inspector.example" },
    });
    expect(mcp.headers.get("access-control-allow-origin")).toBe("*");
    expect(mcp.headers.get("access-control-allow-credentials")).toBeNull();
    // The 401's pointer to the authorization server must be readable.
    expect(mcp.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");

    const discovery = await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp`, {
      headers: { origin: "https://inspector.example" },
    });
    expect(discovery.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("still gives the app its credentialed origin on the MCP path", async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { origin: "https://app.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
  });
});