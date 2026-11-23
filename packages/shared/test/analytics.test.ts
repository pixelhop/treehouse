import { describe, expect, it } from "vite-plus/test";
import {
  POSTHOG_API_HOST,
  POSTHOG_ASSET_HOST,
  REDACTED,
  isForwardableResponseHeader,
  isReplayableRoute,
  posthogUpstreamUrl,
  fileExtension,
  proxyRequestHeaders,
  redactEventProperties,
  redactUrl,
} from "../analytics";
import { FILE_TYPES } from "../fileTypes";

// redactUrl is the last line of defence for file names: posthog-js attaches
// $current_url to every event it sends, and this app puts the user's file path
// in the URL. A regression here leaks silently — nothing errors, events keep
// flowing, and the names just start showing up in someone else's dashboard.
// So these tests are deliberately paranoid about the leaky direction.
describe("redactUrl", () => {
  it("keeps the workspace id and drops the file path", () => {
    expect(redactUrl("https://app.trytree.house/w/ws_123/Finances/2026 Tax Return.md")).toBe(
      `https://app.trytree.house/w/ws_123/${REDACTED}`,
    );
  });

  it("redacts deeply nested paths down to a single marker", () => {
    expect(redactUrl("https://app.trytree.house/w/ws_123/a/b/c/d/e/secret.md")).toBe(
      `https://app.trytree.house/w/ws_123/${REDACTED}`,
    );
  });

  it("leaves a bare workspace route alone", () => {
    expect(redactUrl("https://app.trytree.house/w/ws_123")).toBe(
      "https://app.trytree.house/w/ws_123",
    );
    expect(redactUrl("https://app.trytree.house/w/ws_123/")).toBe(
      "https://app.trytree.house/w/ws_123",
    );
  });

  it("keeps the workspace sub-routes that are not user content", () => {
    // /activity is a route name, not a file name — losing it would collapse two
    // genuinely different pages into one row in every dashboard. It is redacted
    // to the same marker as a file, which is the safe-but-blunt trade: we would
    // rather lose a route breakdown than guess wrong about a segment.
    expect(redactUrl("https://app.trytree.house/w/ws_123/activity")).toBe(
      `https://app.trytree.house/w/ws_123/${REDACTED}`,
    );
  });

  it("redacts byte-Worker grants, by route and by shape wherever they appear", () => {
    // `<keyId>.<base64url>`, as long as a real grant (hundreds of characters).
    const grant = `t1.${"Ab9_-".repeat(140)}`;
    expect(redactUrl(`https://blobs.trytree.house/b/${grant}`)).toBe(
      `https://blobs.trytree.house/b/${REDACTED}`,
    );
    expect(redactUrl(`/b/${grant}`)).toBe(`/b/${REDACTED}`);
    // Not under /b/: a proxy prefix, or a route that does not exist yet.
    expect(redactUrl(`https://cdn.example/bytes/${grant}`)).toBe(
      `https://cdn.example/bytes/${REDACTED}`,
    );
    expect(redactUrl(`https://blobs.example/b/${grant}?x=1#y`)).not.toContain(grant.slice(3, 40));
    // Ordinary segments that merely contain a dot are left alone.
    expect(redactUrl("https://app.trytree.house/_nuxt/entry.Dk3a9.js")).toBe(
      "https://app.trytree.house/_nuxt/entry.Dk3a9.js",
    );
  });

  it("redacts share and invite tokens, which are bearer credentials", () => {
    expect(redactUrl("https://app.trytree.house/s/tok_abc123")).toBe(
      `https://app.trytree.house/s/${REDACTED}`,
    );
    expect(redactUrl("https://app.trytree.house/invite/tok_abc123")).toBe(
      `https://app.trytree.house/invite/${REDACTED}`,
    );
  });

  it("drops the query string and the hash wholesale", () => {
    expect(redactUrl("https://app.trytree.house/dashboard?email=a@b.com&q=secret#frag")).toBe(
      "https://app.trytree.house/dashboard",
    );
  });

  it("passes through routes that carry no user data", () => {
    for (const path of ["/", "/dashboard", "/sign-in", "/organizations", "/connect/workspace"]) {
      expect(redactUrl(`https://app.trytree.house${path}`)).toBe(
        `https://app.trytree.house${path}`,
      );
    }
  });

  it("preserves relative URLs as relative", () => {
    expect(redactUrl("/w/ws_123/notes/todo.md")).toBe(`/w/ws_123/${REDACTED}`);
    expect(redactUrl("/dashboard")).toBe("/dashboard");
  });

  it("redacts percent-encoded and unicode file names", () => {
    expect(redactUrl("/w/ws_123/Caf%C3%A9%20notes.md")).toBe(`/w/ws_123/${REDACTED}`);
    expect(redactUrl("/w/ws_123/café/naïve.md")).toBe(`/w/ws_123/${REDACTED}`);
  });

  it("never throws on unparseable input", () => {
    // A throw here would happen inside before_send and take out the capture
    // call that triggered it, so failing closed matters more than fidelity.
    expect(redactUrl("http://[::1")).toBe(REDACTED);
    expect(redactUrl("")).toBe("/");
  });
});

describe("posthogUpstreamUrl", () => {
  it("routes SDK bundles to the asset host", () => {
    expect(posthogUpstreamUrl("static/recorder.js")).toBe(
      `https://${POSTHOG_ASSET_HOST}/static/recorder.js`,
    );
    expect(posthogUpstreamUrl("array/phc_key/config")).toBe(
      `https://${POSTHOG_ASSET_HOST}/array/phc_key/config`,
    );
  });

  it("routes everything else to the ingestion host, keeping the query string", () => {
    expect(posthogUpstreamUrl("i/v0/e/", "?ver=1.2.3")).toBe(
      `https://${POSTHOG_API_HOST}/i/v0/e/?ver=1.2.3`,
    );
  });

  it("tolerates a leading slash on the path", () => {
    expect(posthogUpstreamUrl("/i/v0/e/")).toBe(`https://${POSTHOG_API_HOST}/i/v0/e/`);
  });
});

describe("proxyRequestHeaders", () => {
  it("never forwards our session cookie to the analytics vendor", () => {
    const out = proxyRequestHeaders(
      { cookie: "better-auth.session_token=live-credential", "content-type": "text/plain" },
      POSTHOG_API_HOST,
    );
    expect(out.cookie).toBeUndefined();
    expect(out["content-type"]).toBe("text/plain");
  });

  it("never forwards the Referer, which carries the user's file path", () => {
    // Serving PostHog same-origin is what makes this dangerous: the browser
    // sends the FULL page URL as Referer for same-origin requests, so every
    // event, flag poll and replay chunk carried the open file's path. It is
    // invisible from the payload, so before_send redaction does not touch it.
    const out = proxyRequestHeaders(
      {
        referer: "https://app.trytree.house/w/ws_1/Finances/2026 Tax Return.md",
        "content-type": "text/plain",
      },
      POSTHOG_API_HOST,
    );
    expect(out.referer).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("Tax Return");
    expect(out["content-type"]).toBe("text/plain");
  });

  it("drops the Referer whatever its casing", () => {
    const out = proxyRequestHeaders(
      { Referer: "https://app.trytree.house/w/ws_1/Secret.md" },
      POSTHOG_API_HOST,
    );
    expect(JSON.stringify(out)).not.toContain("Secret.md");
  });

  it("pins the upstream host and forwards the client IP", () => {
    const out = proxyRequestHeaders({}, POSTHOG_API_HOST, "203.0.113.7");
    expect(out.host).toBe(POSTHOG_API_HOST);
    expect(out["x-forwarded-for"]).toBe("203.0.113.7");
  });

  it("drops hop-by-hop and encoding headers", () => {
    const out = proxyRequestHeaders(
      { connection: "keep-alive", "content-length": "12", "accept-encoding": "gzip" },
      POSTHOG_API_HOST,
    );
    expect(out.connection).toBeUndefined();
    expect(out["content-length"]).toBeUndefined();
    expect(out["accept-encoding"]).toBeUndefined();
  });
});

describe("isForwardableResponseHeader", () => {
  it("refuses to let the upstream set first-party cookies on our origin", () => {
    expect(isForwardableResponseHeader("Set-Cookie")).toBe(false);
  });

  it("allows ordinary response headers", () => {
    expect(isForwardableResponseHeader("content-type")).toBe(true);
    expect(isForwardableResponseHeader("cache-control")).toBe(true);
  });
});
// These run on EVERY event posthog-js sends. The properties below are stamped
// on automatically by the SDK — no caller passes them — which is precisely why
// forgetting one leaks silently and forever.
describe("redactEventProperties", () => {
  it("redacts every URL-bearing property the SDK adds", () => {
    const props: Record<string, unknown> = {
      $current_url: "https://app.trytree.house/w/ws_1/Private/Diary.md",
      $pathname: "/w/ws_1/Private/Diary.md",
      $initial_current_url: "https://app.trytree.house/w/ws_1/Old/Notes.md",
      $initial_pathname: "/w/ws_1/Old/Notes.md",
      $referrer: "https://app.trytree.house/s/sharetoken",
      $initial_referrer: "https://app.trytree.house/invite/invitetoken",
    };
    redactEventProperties(props);
    expect(props).toEqual({
      $current_url: `https://app.trytree.house/w/ws_1/${REDACTED}`,
      $pathname: `/w/ws_1/${REDACTED}`,
      $initial_current_url: `https://app.trytree.house/w/ws_1/${REDACTED}`,
      $initial_pathname: `/w/ws_1/${REDACTED}`,
      $referrer: `https://app.trytree.house/s/${REDACTED}`,
      $initial_referrer: `https://app.trytree.house/invite/${REDACTED}`,
    });
  });

  it("leaves $direct alone", () => {
    // posthog-js uses the literal "$direct" to mean "no referrer". Parsing it
    // as a URL would replace it with the redaction marker and silently destroy
    // direct-traffic reporting.
    const props: Record<string, unknown> = { $referrer: "$direct" };
    redactEventProperties(props);
    expect(props.$referrer).toBe("$direct");
  });

  it("leaves non-URL properties untouched", () => {
    const props: Record<string, unknown> = {
      extension: "md",
      bytes: 4096,
      $current_url: "/dashboard",
    };
    redactEventProperties(props);
    expect(props).toEqual({ extension: "md", bytes: 4096, $current_url: "/dashboard" });
  });

  it("tolerates missing properties", () => {
    expect(redactEventProperties(undefined)).toBeUndefined();
    expect(redactEventProperties({})).toEqual({});
  });
});

describe("isReplayableRoute", () => {
  it("refuses to record public share pages", () => {
    expect(isReplayableRoute("/s/sharetoken123")).toBe(false);
  });

  it("records the authenticated product", () => {
    for (const path of ["/", "/dashboard", "/w/ws_1/notes.md", "/organizations", "/sign-in"]) {
      expect(isReplayableRoute(path)).toBe(true);
    }
  });

  it("does not confuse other routes that merely start with s", () => {
    expect(isReplayableRoute("/sign-up")).toBe(true);
    expect(isReplayableRoute("/settings")).toBe(true);
  });
});
// The browser emits API URLs too, not just app routes: session replay captures
// network request URLs, and a download link's href points straight at
// /api/workspaces/:id/files/<the user's path>. Both surfaces share these rules.
describe("redactUrl — API routes", () => {
  it("strips the file path from file, list and search routes", () => {
    expect(redactUrl("/api/workspaces/ws_1/files/Finances/2026 Tax Return.md")).toBe(
      `/api/workspaces/ws_1/files/${REDACTED}`,
    );
    expect(redactUrl("/api/workspaces/ws_1/list/Private/Notes")).toBe(
      `/api/workspaces/ws_1/list/${REDACTED}`,
    );
    expect(redactUrl("/api/workspaces/ws_1/search/secret")).toBe(
      `/api/workspaces/ws_1/search/${REDACTED}`,
    );
  });

  it("keeps the bare route when nothing follows it", () => {
    expect(redactUrl("/api/workspaces/ws_1/files")).toBe("/api/workspaces/ws_1/files");
    expect(redactUrl("/api/workspaces/ws_1")).toBe("/api/workspaces/ws_1");
  });

  it("strips share and invite tokens", () => {
    expect(redactUrl("/api/share/tok_abc/file")).toBe(`/api/share/${REDACTED}`);
    expect(redactUrl("/api/invites/tok_abc/accept")).toBe(`/api/invites/${REDACTED}`);
  });

  it("leaves API routes that carry no user data intact", () => {
    for (const path of [
      "/api/health",
      "/api/keys",
      "/api/workspaces",
      "/api/workspaces/ws_1/changes",
      "/api/mcp",
    ]) {
      expect(redactUrl(path)).toBe(path);
    }
  });

  it("redacts absolute API URLs, which is the form the replay records", () => {
    expect(redactUrl("https://api.trytree.house/api/workspaces/ws_1/files/Diary.md")).toBe(
      `https://api.trytree.house/api/workspaces/ws_1/files/${REDACTED}`,
    );
  });

  it("leaves build assets and stylesheets alone, so replays still render", () => {
    // maskAttributeFn runs href/src through this. If it mangled asset URLs the
    // replay would lose its CSS entirely.
    for (const path of ["/_nuxt/entry.abc123.css", "/favicon.ico", "/_nuxt/Chunk.js"]) {
      expect(redactUrl(path)).toBe(path);
    }
  });
});
// The extension is the ONLY thing derived from a file path that we let out of
// the browser or the server, so it is the one place a path can still escape.
// The naive `path.lastIndexOf(".")` searches the whole path and leaks folder
// AND file names; these cases are the ones that caught it.
describe("fileExtension", () => {
  it("does not let a dotted FOLDER name leak the file name", () => {
    // "Private.secret/Tax Return" -> lastIndexOf(".") lands in the folder, so
    // the naive version reported "secret/tax return".
    expect(fileExtension("Private.secret/Tax Return")).toBe("none");
    expect(fileExtension("a.b.c/d")).toBe("none");
    expect(fileExtension("Holiday.photos/Mum and Dad")).toBe("none");
  });

  it("does not let a dot INSIDE a file name leak the rest of it", () => {
    // No folder involved: the basename rule alone does not save this one.
    expect(fileExtension("Report v1.2 final")).toBe("other");
    expect(fileExtension("notes/Budget v2.1 draft")).toBe("other");
  });

  it("still reports every file type Treehouse actually renders", () => {
    // Guards the allow-list against being trimmed below what the product needs:
    // every extension in the file-type table has a viewer or a stored type, so
    // bucketing it as "other" would blind the most useful breakdown we have.
    const rendered = Object.keys(FILE_TYPES);
    for (const ext of rendered) {
      expect(fileExtension(`file.${ext}`)).toBe(ext);
    }
  });

  it("reports ordinary extensions", () => {
    expect(fileExtension("Finances/2026 Tax Return.md")).toBe("md");
    expect(fileExtension("photo.JPEG")).toBe("jpeg");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
    expect(fileExtension("a/b/c/script.ts")).toBe("ts");
  });

  it("reports 'none' when there is no extension", () => {
    expect(fileExtension("notes/todo")).toBe("none");
    expect(fileExtension("README")).toBe("none");
    // Dotfiles have no extension by convention — and treating ".env" as
    // extension "env" would be wrong as well as chatty.
    expect(fileExtension(".env")).toBe("none");
    expect(fileExtension("config/.gitignore")).toBe("none");
    // Trailing dot: nothing after it.
    expect(fileExtension("weird.")).toBe("none");
  });

  it("refuses anything that does not look like an extension", () => {
    // Long or non-alphanumeric tails are user text, not extensions.
    expect(fileExtension("file.thisisaverylongsuffix")).toBe("other");
    expect(fileExtension("file.my secret")).toBe("other");
    expect(fileExtension("file.aàb")).toBe("other");
  });

  it("refuses a short alphanumeric tail that is NOT a known file type", () => {
    // The hard case, and the reason this is an allow-list rather than a shape
    // check: these all look exactly like extensions and none of them are. They
    // are somebody's diagnosis, client, colleague and classification.
    expect(fileExtension("Diagnosis.HIV")).toBe("other");
    expect(fileExtension("Client.Acme")).toBe("other");
    expect(fileExtension("Salary.Bob")).toBe("other");
    expect(fileExtension("Notes.Confidential")).toBe("other");
    expect(fileExtension("Deal.Redacted")).toBe("other");
  });

  it("never returns a value that was not on the allow-list", () => {
    // Property-style sweep: whatever we invent after a dot, the output is
    // either a known type, "other", or "none" — never the input text.
    const invented = ["hiv", "acme", "bob", "nda", "q3", "wife", "divorce", "gp", "hr"];
    for (const tail of invented) {
      const out = fileExtension(`file.${tail}`);
      expect(["other", "none"]).toContain(out);
    }
  });

  it("never returns anything containing a slash or a space", () => {
    const paths = [
      "Private.secret/Tax Return",
      "Report v1.2 final",
      "a.b/c d",
      "Clients.2026/Acme Ltd Proposal",
    ];
    for (const p of paths) {
      const ext = fileExtension(p);
      expect(ext).not.toContain("/");
      expect(ext).not.toContain(" ");
    }
  });
});
// Attribution and privacy pull in opposite directions here, so both sides are
// pinned: paths must go, and the things that answer "where did this person come
// from" must stay. Getting either wrong is a silent failure — one leaks file
// names, the other quietly destroys marketing reporting.
describe("redactEventProperties — session entry and attribution", () => {
  it("redacts the URL the session STARTED on", () => {
    // Sticky for the whole session, so this is worse than $current_url: anyone
    // deep-linking, bookmarking, or just refreshing while a file is open would
    // otherwise put that path on every subsequent event.
    const props: Record<string, unknown> = {
      $session_entry_url: "https://app.trytree.house/w/ws_1/Finances/2026 Tax Return.md",
      $session_entry_pathname: "/w/ws_1/Finances/2026 Tax Return.md",
      $session_entry_referrer: "https://app.trytree.house/w/ws_1/Private/Diary.md",
    };
    redactEventProperties(props);
    expect(props.$session_entry_url).toBe(`https://app.trytree.house/w/ws_1/${REDACTED}`);
    expect(props.$session_entry_pathname).toBe(`/w/ws_1/${REDACTED}`);
    expect(props.$session_entry_referrer).toBe(`https://app.trytree.house/w/ws_1/${REDACTED}`);
    expect(JSON.stringify(props)).not.toContain("Tax Return");
    expect(JSON.stringify(props)).not.toContain("Diary");
  });

  it("KEEPS everything marketing attribution depends on", () => {
    // These carry a bare domain or a campaign tag — no path — and they are how
    // "where did this signup come from" gets answered. Redacting them would buy
    // no privacy at all and cost every acquisition report.
    const props: Record<string, unknown> = {
      $referring_domain: "news.ycombinator.com",
      $session_entry_referring_domain: "twitter.com",
      $session_entry_utm_source: "twitter",
      $session_entry_utm_medium: "social",
      $session_entry_utm_campaign: "launch",
      $session_entry_gclid: "abc123",
      utm_source: "twitter",
      gclid: "abc123",
    };
    const before = JSON.stringify(props);
    redactEventProperties(props);
    expect(JSON.stringify(props)).toBe(before);
  });

  it("keeps the domain and path of an EXTERNAL referrer", () => {
    // An inbound link from HN or X is not ours to redact — knowing which post
    // sent someone is the point.
    const props: Record<string, unknown> = {
      $referrer: "https://twitter.com/pixelhop/status/1234567890",
      $initial_referrer: "https://news.ycombinator.com/item",
    };
    redactEventProperties(props);
    expect(props.$referrer).toBe("https://twitter.com/pixelhop/status/1234567890");
    expect(props.$initial_referrer).toBe("https://news.ycombinator.com/item");
  });

  it("catches a URL property this SDK version has not invented yet", () => {
    // The rule is name-shape based precisely so a future posthog-js property
    // cannot sail through the way $session_entry_url did.
    const props: Record<string, unknown> = {
      $some_future_page_url: "https://app.trytree.house/w/ws_1/Secret.md",
      $another_new_pathname: "/w/ws_1/Secret.md",
    };
    redactEventProperties(props);
    expect(JSON.stringify(props)).not.toContain("Secret.md");
  });
});