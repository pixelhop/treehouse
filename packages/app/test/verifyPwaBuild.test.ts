import { describe, expect, it } from "vite-plus/test";
import {
  apiUrlFailures,
  bakedApiUrl,
  htmlFailures,
  manifestFailures,
  parseJsonc,
  swFailures,
  wranglerApiUrl,
} from "../scripts/verify-pwa-build.mjs";

// The verifier is what stands between a bad generated worker and a deploy
// (package.json chains it after `nuxt build`). These fixtures include the two
// false-pass shapes found in PR #74's review: a worker with a root precache
// string but no bound navigation route, and a worker with zero skipWaiting
// handlers (both previously passed).

// Shaped like the real minified Workbox output.
const GOOD_SW =
  'self.addEventListener("message",n=>{n.data&&"SKIP_WAITING"===n.data.type&&self.skipWaiting()}),' +
  'n.clientsClaim(),n.precacheAndRoute([{revision:"1",url:"/"},{revision:null,url:"_nuxt/a.js"}]),' +
  'n.registerRoute(new n.NavigationRoute(n.createHandlerBoundToURL("/"),{denylist:[/^\\/\\.well-known\\//,/^\\/api\\//]}))';

describe("swFailures", () => {
  it("passes the real worker shape", () => {
    expect(swFailures(GOOD_SW)).toEqual([]);
  });

  it("fails a worker whose precache has no root entry", () => {
    const sw = GOOD_SW.replace('{revision:"1",url:"/"},', "");
    expect(swFailures(sw).join()).toMatch(/no entry for "\/"/);
  });

  it("fails the false-pass fixture: root precache string but no bound navigation route", () => {
    const sw =
      'self.addEventListener("message",n=>{n.data&&"SKIP_WAITING"===n.data.type&&self.skipWaiting()}),' +
      'n.clientsClaim(),n.precacheAndRoute([{revision:"1",url:"/"}])';
    expect(swFailures(sw).join()).toMatch(/navigation fallback handler/);
  });

  it("fails the false-pass fixture: zero skipWaiting handlers (updates could never activate)", () => {
    const sw = GOOD_SW.replace(
      'self.addEventListener("message",n=>{n.data&&"SKIP_WAITING"===n.data.type&&self.skipWaiting()}),',
      "",
    );
    expect(swFailures(sw).join()).toMatch(/exactly one skipWaiting/);
  });

  it("fails an unconditional skipWaiting (would reload tabs over unsaved edits)", () => {
    const sw = `self.skipWaiting(),${GOOD_SW}`;
    expect(swFailures(sw).join()).toMatch(/exactly one skipWaiting/);
  });

  it("fails a worker without clientsClaim (activation reload would never fire)", () => {
    const sw = GOOD_SW.replace("n.clientsClaim(),", "");
    expect(swFailures(sw).join()).toMatch(/clientsClaim/);
  });
});

describe("manifestFailures", () => {
  const GOOD = {
    name: "Treehouse",
    display: "standalone",
    icons: [
      { src: "/pwa-192x192.png", sizes: "192x192" },
      { src: "/maskable-icon-512x512.png", sizes: "512x512", purpose: "maskable" },
    ],
  };

  it("passes the shipped manifest shape", () => {
    expect(manifestFailures(GOOD)).toEqual([]);
  });

  it("requires both an ordinary and a maskable icon", () => {
    expect(manifestFailures({ ...GOOD, icons: [GOOD.icons[0]] }).join()).toMatch(/maskable/);
    expect(manifestFailures({ ...GOOD, icons: [GOOD.icons[1]] }).join()).toMatch(/maskable/);
  });
});

describe("htmlFailures", () => {
  it("requires the manifest link and theme-color meta", () => {
    const good =
      '<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#F7F4EC">';
    expect(htmlFailures(good)).toEqual([]);
    expect(htmlFailures("<html></html>")).toHaveLength(2);
  });
});
describe("bakedApiUrl", () => {
  it("reads the apiUrl frozen into the prerendered shell's config payload", () => {
    const html =
      '<script>window.__NUXT__={};window.__NUXT__.config={public:{apiUrl:"https://api.example.com",posthog:{key:"",host:"/ph"}},app:{baseURL:"/"}}</script>';
    expect(bakedApiUrl(html)).toBe("https://api.example.com");
  });

  it("is null when the shell has no config payload at all", () => {
    expect(bakedApiUrl('<div id="__nuxt"></div>')).toBeNull();
  });
});

describe("apiUrlFailures", () => {
  const expected = "https://api.example.com";

  it("passes when the baked shell and the Worker var agree", () => {
    expect(apiUrlFailures({ baked: expected, expected })).toEqual([]);
  });

  // The production incident: a stale build variable froze a retired API host
  // into the shell while the runtime var (and the API's cookie domain) had
  // moved on. Sign-in posted to the old host and the browser dropped the cookie.
  it("fails when the shell bakes a different API origin than wrangler.jsonc declares", () => {
    const failures = apiUrlFailures({ baked: "https://old-api.example.com", expected });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/old-api\.example\.com/);
    expect(failures[0]).toMatch(/api\.example\.com/);
    expect(failures[0]).toMatch(/BUILD-time/);
  });

  it("lets a dev build (nuxt.config default) through — preflight-deploy refuses to ship it", () => {
    expect(apiUrlFailures({ baked: "http://localhost:3010", expected })).toEqual([]);
  });

  it("has nothing to compare against when wrangler.jsonc declares no var", () => {
    expect(apiUrlFailures({ baked: expected, expected: undefined })).toEqual([]);
  });

  it("fails a shell with no config payload (not prerendered, so not precacheable)", () => {
    expect(apiUrlFailures({ baked: null, expected }).join()).toMatch(/not prerendered/);
  });
});

describe("wranglerApiUrl", () => {
  const wrangler = {
    vars: { NUXT_PUBLIC_API_URL: "https://api.example.com" },
    env: { staging: { vars: { NUXT_PUBLIC_API_URL: "https://staging-api.example.com" } } },
  };

  it("uses the top-level vars when no environment is targeted", () => {
    expect(wranglerApiUrl(wrangler, undefined)).toEqual({
      expected: "https://api.example.com",
      failures: [],
    });
  });

  // A wrangler environment does not inherit `vars`: checking a staging build
  // against the top-level value would fail every correct staging build.
  it("uses the targeted environment's own vars, not production's", () => {
    expect(wranglerApiUrl(wrangler, "staging")).toEqual({
      expected: "https://staging-api.example.com",
      failures: [],
    });
  });

  it("fails when CLOUDFLARE_ENV names an environment wrangler.jsonc does not define", () => {
    const result = wranglerApiUrl(wrangler, "preview");
    expect(result.expected).toBeUndefined();
    expect(result.failures.join()).toMatch(/CLOUDFLARE_ENV=preview has no env\.preview block/);
  });
});

describe("parseJsonc", () => {
  it("strips line and block comments outside strings and tolerates trailing commas", () => {
    const text = `{
  // line comment
  "name": "x", /* block */
  "url": "https://example.com/not-a-comment", // trailing
  "vars": { "A": "1", },
}`;
    expect(parseJsonc(text)).toEqual({
      name: "x",
      url: "https://example.com/not-a-comment",
      vars: { A: "1" },
    });
  });

  it("keeps escaped quotes inside strings intact", () => {
    expect(parseJsonc('{"s": "a \\"b\\" // c"}')).toEqual({ s: 'a "b" // c' });
  });
});