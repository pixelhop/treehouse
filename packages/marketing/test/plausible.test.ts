// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PLAUSIBLE_EVENT_PATH,
  PLAUSIBLE_SCRIPT_PATH,
  isPlausibleScriptId,
} from "../app/utils/plausible";
import { visitorIp } from "../server/utils/proxy";

type Plugin = () => unknown;

let scriptId: string;
let plugin: Plugin;

beforeAll(async () => {
  vi.stubGlobal("defineNuxtPlugin", (candidate: Plugin) => candidate);
  vi.stubGlobal("useRuntimeConfig", () => ({ public: { plausible: { scriptId } } }));
  plugin = (await import("../app/plugins/plausible.client")).default as Plugin;
});

beforeEach(() => {
  delete window.plausible;
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

describe("marketing Plausible plugin", () => {
  it("loads the script from our proxy and points events at it", () => {
    scriptId = "pa-OirF1Eoh4Iqm7TJJE9RW2";
    plugin();

    const scripts = [...document.head.querySelectorAll("script")];
    expect(scripts.map((s) => s.getAttribute("src"))).toEqual([PLAUSIBLE_SCRIPT_PATH]);
    expect(window.plausible?.o).toEqual({ endpoint: PLAUSIBLE_EVENT_PATH });
  });

  it("queues calls made before the script arrives", () => {
    scriptId = "pa-OirF1Eoh4Iqm7TJJE9RW2";
    plugin();
    window.plausible?.("Signup");
    expect(window.plausible?.q).toEqual([["Signup"]]);
  });

  it("loads nothing without a script id", () => {
    scriptId = "";
    plugin();
    expect(document.head.querySelectorAll("script")).toHaveLength(0);
    expect(window.plausible).toBeUndefined();
  });
});

describe("isPlausibleScriptId", () => {
  it("accepts Plausible's per-site ids and nothing path-shaped", () => {
    expect(isPlausibleScriptId("pa-OirF1Eoh4Iqm7TJJE9RW2")).toBe(true);
    expect(isPlausibleScriptId("")).toBe(false);
    expect(isPlausibleScriptId("script")).toBe(false);
    expect(isPlausibleScriptId("pa-../../api/x")).toBe(false);
  });
});

describe("visitorIp", () => {
  it("prefers Cloudflare's header, then the first forwarded hop, then the runtime", () => {
    expect(
      visitorIp({ "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.2" }),
    ).toBe("203.0.113.1");
    expect(visitorIp({ "x-forwarded-for": "198.51.100.2, 10.0.0.1" }, "127.0.0.1")).toBe(
      "198.51.100.2",
    );
    expect(visitorIp({}, "127.0.0.1")).toBe("127.0.0.1");
  });
});