// Shell-side consumption of the Treehouse well-known descriptor (R15): a client
// holding only an app origin (from an invite/deep link) discovers the API origin
// without user input.
//
// DEVIATION (recorded): the canonical validator lives in
// `packages/app/server/utils/descriptor.ts`, but that module is inside the Nuxt
// app package (Cloudflare/Nuxt runtime) and isn't a clean node-importable library
// like the `cli` package is. Rather than couple the desktop bundle to the app
// package's internals, this mirrors the same tiny, pure contract. `parseDescriptor`
// here must stay behaviourally identical to the app-side one — it's a cross-version
// contract with every deployed instance.

export interface TreehouseDescriptor {
  product: "treehouse";
  version: number;
  /** The API origin the app talks to (no trailing slash). */
  apiUrl: string;
}

const stripTrailingSlash = (s: string): string => s.replace(/\/+$/, "");

/**
 * Validate a fetched descriptor before trusting it. Returns null for anything
 * that isn't a well-formed Treehouse descriptor with an https apiUrl — so a
 * missing endpoint and a malformed/non-https one are treated identically
 * ("not a Treehouse server?"). `allowInsecure` permits http://localhost for dev.
 */
export function parseDescriptor(
  raw: unknown,
  opts: { allowInsecure?: boolean } = {},
): TreehouseDescriptor | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.product !== "treehouse") return null;
  if (typeof d.apiUrl !== "string") return null;

  let url: URL;
  try {
    url = new URL(d.apiUrl);
  } catch {
    return null;
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const secure = url.protocol === "https:";
  const localDev = opts.allowInsecure === true && url.protocol === "http:" && isLocalhost;
  if (!secure && !localDev) return null;

  const version = typeof d.version === "number" ? d.version : 1;
  return { product: "treehouse", version, apiUrl: stripTrailingSlash(d.apiUrl) };
}

/**
 * Read at most `maxBytes` of a response body, cancelling as soon as the cap is
 * exceeded. Buffering the whole body first (`res.text()`) and measuring after the
 * fact makes the cap useless — a hostile or broken endpoint can exhaust memory
 * inside the fetch timeout. Returns null if the body is over the cap or unreadable.
 */
async function readBodyLimited(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Fetch + validate the well-known descriptor from an app origin. Bounded by a
 * timeout and a small response cap (an invalid descriptor is treated as missing).
 * Returns null on any failure so callers get one uniform "not a Treehouse server?"
 * outcome. `allowInsecure` (dev) permits an http://localhost app origin.
 */
export async function fetchDescriptor(
  appOrigin: string,
  opts: { allowInsecure?: boolean; timeoutMs?: number } = {},
): Promise<TreehouseDescriptor | null> {
  let base: URL;
  try {
    base = new URL(appOrigin);
  } catch {
    return null;
  }
  // Mirror `parseDescriptor`'s rule exactly: the insecure escape hatch is for
  // http://localhost during development only. Accepting http:// for ANY host
  // would let a dev build discover its API origin over interceptable plaintext.
  const baseIsLocalhost = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  const baseLocalDev = opts.allowInsecure === true && base.protocol === "http:" && baseIsLocalhost;
  if (base.protocol !== "https:" && !baseLocalDev) return null;

  const url = `${base.origin}/.well-known/treehouse`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!res.ok) return null;
    // A descriptor is tiny; anything large is suspect. Enforced while streaming
    // so an oversized body is abandoned mid-flight rather than fully buffered.
    const text = await readBodyLimited(res, 4096);
    if (text === null) return null;
    return parseDescriptor(JSON.parse(text) as unknown, { allowInsecure: opts.allowInsecure });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}