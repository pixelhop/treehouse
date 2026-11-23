// Deciding whether an HTML file wants to run, and remembering what the user
// answered. The sandbox that makes running it safe lives in ./htmlSandbox.ts;
// this is the consent layer on top of it.
//
// Pure on purpose (the composable in ~/composables/useHtmlScriptGrants.ts is a
// thin useState + localStorage wrapper), so the rules below are testable without
// a browser.

/**
 * `type` values a browser will actually execute. Empty is the common case; the
 * legacy aliases are still honored by every engine. Everything else — the
 * `application/ld+json` block in a generated report, an `text/x-template` chunk
 * — is inert data that happens to live in a <script> tag, and prompting about it
 * would train people to click through the prompt that matters.
 */
const EXECUTABLE_SCRIPT_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/jscript",
  "text/livescript",
  "text/x-javascript",
  "text/x-ecmascript",
]);

/** Attributes whose value is a URL, and so could carry a `javascript:` payload. */
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);

/**
 * True when this HTML would execute something if the sandbox let it — an
 * executable <script>, an inline `on*` handler, or a `javascript:` URL.
 *
 * Parsed rather than pattern-matched: `<script>` inside a <pre> block or a
 * comment is not code, and a regex cannot tell the difference. The parse happens
 * in an inert document created by `createHTMLDocument`, which has no browsing
 * context — nothing loads, nothing runs, exactly as in `rewriteHtmlRefs`.
 *
 * `doc` defaults to the browser document; tests pass a happy-dom one. With no
 * DOM at all this answers false: no prompt is better than a prompt we cannot
 * justify.
 */
export function containsExecutableScript(html: string, doc?: Document): boolean {
  const d = doc ?? (typeof document === "undefined" ? undefined : document);
  if (!d || !html) return false;

  const parsed = d.implementation.createHTMLDocument("");
  parsed.documentElement.innerHTML = html;

  for (const script of parsed.querySelectorAll("script")) {
    const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
    if (EXECUTABLE_SCRIPT_TYPES.has(type)) return true;
  }

  for (const el of parsed.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      // An empty handler (`onclick=""`) executes nothing, and generated markup
      // is full of them.
      if (name.startsWith("on") && attr.value.trim() !== "") return true;
      if (URL_ATTRS.has(name) && /^\s*javascript:/i.test(attr.value)) return true;
    }
  }

  return false;
}

/**
 * A digest of the exact bytes the viewer is showing, hex-encoded, or null when
 * one cannot be produced (no Web Crypto — `crypto.subtle` needs a secure
 * context). Null is a refusal to identify the content, and every caller treats
 * it as "no grant applies", so the failure mode is a prompt rather than a run.
 *
 * SHA-256 rather than something cheap and synchronous because this IS the
 * consent boundary: a page whose bytes an attacker controls must not be able to
 * collide its way into a permission granted to different bytes.
 */
export async function contentIdentity(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * What the user last said about one file, and — crucially — WHICH BYTES they
 * said it about.
 *
 * This is a content digest rather than a file version because a version is not
 * an identity for bytes. Two ways it fails, both real: the file service starts
 * every newly created node at version 1, so a path that is deleted and recreated
 * (or has another file moved onto it) presents different content under the same
 * path-and-version a grant was written for; and the bytes the viewer renders are
 * read from the mutable head, so a write landing between the directory listing
 * and that read serves content the listed version never described. A digest of
 * what is actually on screen is immune to both.
 */
export interface ScriptDecision {
  contentId: string;
  allow: boolean;
}

/** Decisions by scope (user + workspace), then by file path. */
export type ScriptGrantStore = Record<string, Record<string, ScriptDecision>>;

/**
 * - `allowed` — run it, no prompt. Pinned to the bytes that were allowed.
 * - `stale` — allowed, but the content has changed since. Ask again.
 * - `dismissed` — they said no. Never ask again for this file.
 * - `unasked` — no decision on record, or no identity to check one against.
 */
export type ScriptStance = "allowed" | "stale" | "dismissed" | "unasked";

/**
 * The asymmetry here is deliberate, and it is the whole design:
 *
 * An **allow is pinned to the content it was given to**. A workspace file is
 * often written by an agent, so "I trust this deck" cannot mean "I trust
 * whatever this path holds next week" — different bytes have to be consented to
 * again, however they came to be there.
 *
 * A **dismissal is not pinned**. Re-asking after every save would be pure
 * nagging: saying no leaves the page exactly as inert as it already was, so
 * there is nothing for a content check to protect.
 *
 * `contentId` of null (nothing identifiable on screen yet, or no Web Crypto)
 * answers `unasked`: without knowing which bytes are in front of the user, there
 * is no grant that can honestly be said to apply.
 */
export function scriptStance(
  store: ScriptGrantStore,
  scope: string | null,
  path: string,
  contentId: string | null,
): ScriptStance {
  if (!scope) return "unasked";
  const decision = store[scope]?.[path];
  if (!decision) return "unasked";
  if (!decision.allow) return "dismissed";
  if (!contentId) return "unasked";
  return decision.contentId === contentId ? "allowed" : "stale";
}

/** The store with one file's decision recorded. Returns a new object (state). */
export function withScriptDecision(
  store: ScriptGrantStore,
  scope: string,
  path: string,
  contentId: string,
  allow: boolean,
): ScriptGrantStore {
  return { ...store, [scope]: { ...store[scope], [path]: { contentId, allow } } };
}

/**
 * Coerce whatever is in storage into the current shape, dropping anything that
 * doesn't fit. A corrupt, hand-edited or OUTDATED payload must not be able to
 * turn itself into a standing permission to execute — including the earlier
 * version-keyed shape, whose entries are deliberately dropped rather than
 * migrated, because there is no way to tell whether the bytes they approved are
 * the bytes on disk today. Everything unreadable falls back to "unasked", which
 * prompts.
 */
export function normalizeGrants(raw: unknown): ScriptGrantStore {
  const out: ScriptGrantStore = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [scope, files] of Object.entries(raw as Record<string, unknown>)) {
    if (!files || typeof files !== "object") continue;
    const bucket: Record<string, ScriptDecision> = {};
    for (const [path, decision] of Object.entries(files as Record<string, unknown>)) {
      const d = decision as Partial<ScriptDecision> | null;
      if (!d || typeof d !== "object") continue;
      if (typeof d.contentId !== "string" || d.contentId === "") continue;
      if (typeof d.allow !== "boolean") continue;
      bucket[path] = { contentId: d.contentId, allow: d.allow };
    }
    if (Object.keys(bucket).length > 0) out[scope] = bucket;
  }
  return out;
}