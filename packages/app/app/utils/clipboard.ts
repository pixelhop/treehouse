/**
 * Copy text that isn't known yet — a share link the server is still creating.
 *
 * Safari only lets a page write to the clipboard inside the click that asked
 * for it, and a network round trip outlives that. A ClipboardItem accepts a
 * promise for its contents, so the write starts inside the click and finishes
 * when the text arrives. Browsers without that fall back to an ordinary write
 * once the text is in hand, which Chromium (and so the desktop app) allows.
 *
 * Resolves true when the text reached the clipboard. Never rejects on a
 * clipboard refusal; a rejected `text` (the create failed) resolves false.
 */
export async function copyWhenReady(text: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    } catch {
      // Fall through: some browsers refuse promise-valued items.
    }
  }
  try {
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}