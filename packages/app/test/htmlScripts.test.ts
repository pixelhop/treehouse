import { Window } from "happy-dom";
import { describe, expect, it } from "vite-plus/test";
import {
  containsExecutableScript,
  contentIdentity,
  normalizeGrants,
  type ScriptGrantStore,
  scriptStance,
  withScriptDecision,
} from "../app/utils/htmlScripts";

// Detection takes an explicit Document so tests run in the default Node
// environment with a happy-dom document, as in html-refs.test.ts.
const doc = new Window().document as unknown as Document;
const has = (html: string) => containsExecutableScript(html, doc);

describe("containsExecutableScript", () => {
  it("finds a plain script, a module, and a legacy type", () => {
    expect(has("<script>alert(1)</script>")).toBe(true);
    expect(has(`<script type="module">export {}</script>`)).toBe(true);
    expect(has(`<script type="text/javascript">x()</script>`)).toBe(true);
    expect(has(`<script src="deck.js"></script>`)).toBe(true);
  });

  it("finds inline handlers and javascript: URLs", () => {
    expect(has(`<button onclick="go()">go</button>`)).toBe(true);
    expect(has(`<body onload="init()"><p>hi</p></body>`)).toBe(true);
    expect(has(`<a href="javascript:go()">go</a>`)).toBe(true);
    expect(has(`<a href="  JavaScript:go()">go</a>`)).toBe(true);
  });

  it("ignores script tags that hold data rather than code", () => {
    // A generated report routinely carries JSON-LD. Prompting about it would
    // teach people that this prompt is noise.
    expect(has(`<script type="application/ld+json">{"a":1}</script>`)).toBe(false);
    expect(has(`<script type="text/x-template"><p>hi</p></script>`)).toBe(false);
  });

  it("ignores an empty handler attribute", () => {
    expect(has(`<button onclick="">go</button>`)).toBe(false);
  });

  it("is not fooled by script-shaped text", () => {
    // The reason this parses instead of pattern-matching: neither of these runs.
    expect(has("<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>")).toBe(false);
    expect(has("<!-- <script>alert(1)</script> -->")).toBe(false);
  });

  it("says no for an ordinary page and for nothing at all", () => {
    expect(has("<h1>Q3 review</h1><p>Slides.</p>")).toBe(false);
    expect(has("")).toBe(false);
  });
});

describe("contentIdentity", () => {
  it("is stable for the same bytes and different for any change", async () => {
    const deck = "<h1>Q3</h1><script>go()</script>";
    expect(await contentIdentity(deck)).toBe(await contentIdentity(deck));
    expect(await contentIdentity(deck)).not.toBe(await contentIdentity(deck + " "));
  });

  it("is a sha-256 hex digest, not a cheap hash", async () => {
    // Cheap hashes are collidable by anyone who controls the bytes, and these
    // bytes are exactly what an attacker would control.
    expect(await contentIdentity("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("scriptStance", () => {
  const DECK = "sha-of-the-deck";
  const allowed: ScriptGrantStore = { "u1:ws1": { "deck.html": { contentId: DECK, allow: true } } };

  it("prompts when there is no decision on record", () => {
    expect(scriptStance({}, "u1:ws1", "deck.html", DECK)).toBe("unasked");
    expect(scriptStance(allowed, "u1:ws1", "other.html", DECK)).toBe("unasked");
  });

  it("runs the exact bytes that were allowed", () => {
    expect(scriptStance(allowed, "u1:ws1", "deck.html", DECK)).toBe("allowed");
  });

  it("re-asks once the content changes, however it changed", () => {
    // The security property of the whole feature, and the reason the identity is
    // a digest: an edit, a delete-and-recreate at version 1, or another file
    // moved onto the path all present different bytes, and none of them inherit
    // the earlier yes.
    expect(scriptStance(allowed, "u1:ws1", "deck.html", "sha-of-something-else")).toBe("stale");
  });

  it("will not apply a grant to content it cannot identify", () => {
    // No digest (no Web Crypto, or the bytes have not settled) means no honest
    // claim that this is what was approved. Fail closed: prompt.
    expect(scriptStance(allowed, "u1:ws1", "deck.html", null)).toBe("unasked");
  });

  it("keeps one signed-in user's answers away from another's", () => {
    // Same browser, same workspace, different account.
    expect(scriptStance(allowed, "u2:ws1", "deck.html", DECK)).toBe("unasked");
    expect(scriptStance(allowed, null, "deck.html", DECK)).toBe("unasked");
  });

  it("keeps a no across content changes — re-asking would only be nagging", () => {
    const dismissed: ScriptGrantStore = {
      "u1:ws1": { "deck.html": { contentId: DECK, allow: false } },
    };
    expect(scriptStance(dismissed, "u1:ws1", "deck.html", DECK)).toBe("dismissed");
    expect(scriptStance(dismissed, "u1:ws1", "deck.html", "anything-else")).toBe("dismissed");
    expect(scriptStance(dismissed, "u1:ws1", "deck.html", null)).toBe("dismissed");
  });
});

describe("withScriptDecision", () => {
  it("records a decision without disturbing the rest of the store", () => {
    const before: ScriptGrantStore = {
      "u1:ws1": { "a.html": { contentId: "sha-a", allow: true } },
      "u1:ws2": { "b.html": { contentId: "sha-b", allow: false } },
    };
    const after = withScriptDecision(before, "u1:ws1", "deck.html", "sha-deck", true);
    expect(after["u1:ws1"]).toEqual({
      "a.html": { contentId: "sha-a", allow: true },
      "deck.html": { contentId: "sha-deck", allow: true },
    });
    expect(after["u1:ws2"]).toEqual(before["u1:ws2"]);
    expect(before["u1:ws1"]?.["deck.html"]).toBeUndefined(); // new object, not mutated
  });

  it("replaces an earlier decision for the same file", () => {
    const store = withScriptDecision(
      { "u1:ws1": { "deck.html": { contentId: "old", allow: true } } },
      "u1:ws1",
      "deck.html",
      "new",
      false,
    );
    expect(store["u1:ws1"]?.["deck.html"]).toEqual({ contentId: "new", allow: false });
  });
});

describe("normalizeGrants", () => {
  it("keeps well-formed decisions", () => {
    const store = { "u1:ws1": { "deck.html": { contentId: "sha", allow: true } } };
    expect(normalizeGrants(store)).toEqual(store);
  });

  it("drops the earlier version-keyed shape rather than migrating it", () => {
    // Those grants named a version, and a version does not identify bytes — so
    // there is no way to tell whether what they approved is what is on disk now.
    expect(normalizeGrants({ "u1:ws1": { "a.html": { version: 2, allow: true } } })).toEqual({});
  });

  it("drops anything malformed rather than trusting it", () => {
    // A junk payload must never read as a standing permission to execute.
    expect(normalizeGrants({ ws1: { "a.html": { contentId: 5, allow: true } } })).toEqual({});
    expect(normalizeGrants({ ws1: { "a.html": { contentId: "", allow: true } } })).toEqual({});
    expect(normalizeGrants({ ws1: { "a.html": { contentId: "sha" } } })).toEqual({});
    expect(normalizeGrants({ ws1: { "a.html": true } })).toEqual({});
    expect(normalizeGrants({ ws1: "nope" })).toEqual({});
    expect(normalizeGrants(null)).toEqual({});
    expect(normalizeGrants("nope")).toEqual({});
  });

  it("keeps the good entries alongside the bad", () => {
    expect(
      normalizeGrants({
        "u1:ws1": {
          "a.html": { contentId: "sha-a", allow: true },
          "b.html": { version: 1, allow: true },
        },
      }),
    ).toEqual({ "u1:ws1": { "a.html": { contentId: "sha-a", allow: true } } });
  });
});