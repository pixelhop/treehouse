import trustArt from "design/assets/raster/trust-roots.webp";

/**
 * Shared content for the trust section.
 *
 * Five layout variations render this same material, so the copy and the
 * demo data live here rather than in any one of them — otherwise comparing
 * layouts turns into comparing slightly-drifted copy.
 *
 * The demos mirror real behaviour: the conflicted-copy filename is the format
 * conflictedCopyName() produces in packages/shared, and the actor colours are
 * design.md's sky-for-agent / moss-for-human pairing.
 */
export interface TrustPoint {
  id: "conflict" | "history" | "undo";
  title: string;
  body: string;
}

export const trustPoints: TrustPoint[] = [
  {
    id: "conflict",
    title: "Conflict-safe writes",
    body: "Every file carries a version. A stale write never overwrites newer work — it lands as a conflicted copy beside the original, both intact.",
  },
  {
    id: "history",
    title: "Loss is the one failure we refuse",
    body: "When a delete races an edit, the file comes back. Past versions stay put, so a file that was changed or removed on purpose can still be restored.",
  },
  {
    id: "undo",
    title: "Take back one agent's work",
    body: "Every change is recorded with the agent that made it. Preview what one agent did since a moment you choose, then undo it in one step. Anything a teammate changed since is left alone.",
  },
];

export const conflictRows = [
  { name: "PRD.md", version: "v8", kind: "human" as const, highlight: false },
  {
    name: "PRD (conflicted copy — agent — 2026-07-29).md",
    version: "v1",
    kind: "agent" as const,
    highlight: true,
  },
];

export const versionHistory = [
  { version: 8, who: "Pixel", kind: "agent" as const, time: "15m", current: true },
  { version: 7, who: "Jozef", kind: "human" as const, time: "2h", current: false },
  { version: 6, who: "Sage", kind: "agent" as const, time: "1d", current: false },
];

/**
 * The undo preview, as docs/files/undo-an-agent.md describes it: the agent's
 * edits come back out, files it deleted come back, and a file someone else has
 * touched since is left alone and says so.
 */
export const undoPreview = [
  { name: "PRD.md", outcome: "edit undone", kept: false },
  { name: "Launch-notes.md", outcome: "brought back", kept: false },
  { name: "positioning.md", outcome: "Sam edited it since — kept", kept: true },
];

export const trustHeading = {
  eyebrow: "Trust",
  title: "Agents make mistakes. Treehouse doesn't lose work.",
  lede: "Letting software write to your files takes trust. Treehouse is built so an agent's mistake costs you a click, not an afternoon: nothing is silently overwritten, old versions can come back, and one agent's work can be undone on its own.",
};

export { trustArt };