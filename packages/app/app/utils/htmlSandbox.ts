// Security contract for rendering untrusted HTML files in the viewer.
//
// HTML in a workspace is written by agents (subject to prompt injection) or
// humans, so it is untrusted. The viewer renders it visually but inertly: no
// scripts, no same-origin, no forms. DOMPurify-sanitizing first is
// defense-in-depth.
//
// NEVER combine `allow-scripts` with `allow-same-origin`: that lets the frame
// script itself in our origin and remove its own sandbox.

/**
 * The iframe `sandbox` value. Scripting stays off; everything enabled here is
 * about letting a link actually go somewhere:
 *
 * - `allow-same-origin` — lets the PARENT reach `iframe.contentDocument` and
 *   attach its own click handler, so an internal link becomes an SPA navigation
 *   instead of a full page reload. It grants the document itself NOTHING: with
 *   no `allow-scripts` it cannot run a line of its own JS, so it can never read
 *   a cookie or touch our DOM. Only our trusted code runs against that document.
 *   It also puts subresource loads back in the app's origin, which is what makes
 *   relative images resolve at all (an opaque origin sends no session cookie).
 * - `allow-top-navigation-by-user-activation` — the fallback path. If the click
 *   handler is not attached (or same-origin access ever throws), the anchor's
 *   `target="_top"` still navigates the top window: a full load, but it works.
 *   Without this token that fallback would instead navigate the FRAME to an app
 *   route it cannot boot, and the preview would go blank.
 * - `allow-popups` + `allow-popups-to-escape-sandbox` — external links open in a
 *   normal new tab. The escape token matters: without it the new tab inherits
 *   this sandbox and renders the external site blank.
 *
 * THE invariant, and the reason same-origin is safe here: never add
 * `allow-scripts`. Same-origin is only dangerous once the untrusted document can
 * execute — that pairing is what `isSafeSandbox` exists to forbid. Kept out:
 * `allow-scripts`, `allow-forms`, `allow-modals`, `allow-pointer-lock`.
 */
export const HTML_SANDBOX =
  "allow-same-origin allow-top-navigation-by-user-activation allow-popups allow-popups-to-escape-sandbox";

/** Don't leak the app URL to anything the HTML references. */
export const HTML_REFERRER_POLICY = "no-referrer";

/**
 * True when a sandbox token string cannot escalate to scripting our origin —
 * i.e. it does NOT enable `allow-scripts` and `allow-same-origin` together.
 */
export function isSafeSandbox(sandbox: string): boolean {
  const tokens = sandbox.split(/\s+/).filter(Boolean);
  return !(tokens.includes("allow-scripts") && tokens.includes("allow-same-origin"));
}

/**
 * The opt-in "run scripts" sandbox, for pages that are useless inert — a slide
 * deck whose arrow keys are JavaScript, a chart that draws itself. Never the
 * default: workspace HTML is routinely agent-written, so executing it has to be
 * a choice a person makes about a file they are looking at.
 *
 * The whole safety of this rests on ONE omission: no `allow-same-origin`. The
 * document lands in an opaque origin, so "same origin" is a site of one — it
 * cannot read a cookie, touch `localStorage`, or reach a line of our DOM. That
 * is the exact trade the default sandbox makes in the other direction, and the
 * two must never be combined (`isSafeSandbox`).
 *
 * What the omission costs, and why each is accepted here:
 * - Workspace-relative media breaks. A sandbox without `allow-same-origin` has a
 *   null site-for-cookies, so the session cookie never rides along and the
 *   file-bytes API answers 401. Self-contained pages (inline CSS, data: URIs,
 *   remote assets) are unaffected; a deck that references `./logo.png` shows a
 *   broken image. Fixing this properly needs cookie-free signed URLs or a
 *   separate preview origin — deliberately out of scope for the opt-in mode.
 * - The parent can no longer intercept link clicks. Internal links get
 *   `target="_blank"` (see `HtmlRefContext.linkTarget`), and a relay script of
 *   ours asks the parent to navigate in place instead (utils/htmlLinkRelay.ts);
 *   the new tab is only the fallback when the relay doesn't run.
 *
 * Deliberately NOT granted:
 * - `allow-top-navigation-by-user-activation` — the default sandbox can afford
 *   it because nothing in the document runs. Here, a page that executes could
 *   turn any stray click into a redirect to a page that looks like our sign-in.
 *   Links stay reachable through `allow-popups` instead, which costs a tab.
 * - `allow-forms`, `allow-modals`, `allow-pointer-lock` — nothing a document
 *   needs in order to present itself, and `allow-modals` alone buys an
 *   unclosable `alert()` loop.
 *
 * What this mode genuinely allows, stated plainly: the page can talk to the
 * internet — load a CDN script, beacon its own contents somewhere. There is no
 * CSP here on purpose. A policy tight enough to stop exfiltration (a URL is a
 * side channel; `img-src https:` leaks just as well as `connect-src`) also
 * blocks the CDN-hosted deck frameworks this feature exists to run, so it would
 * buy breakage rather than safety. The bounded claim is the one that matters:
 * the page can send its own bytes, and can reach nothing else — not the session,
 * not the workspace, not the app.
 */
export const HTML_SCRIPTS_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";