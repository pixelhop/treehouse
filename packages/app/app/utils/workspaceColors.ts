// Palette tokens for the workspace icon tile. The bg-* classes are written as
// literals here so Tailwind detects them (dynamic class strings still resolve to
// these source literals).
// Brand tokens first (see /design.md) — the default lands on leaf so a workspace
// nobody has coloured sits inside the palette rather than fighting it. The
// generic tokens below stay so any colour already chosen still resolves.
export const WORKSPACE_COLORS: Record<string, string> = {
  leaf: "bg-[#2e7d5b]",
  moss: "bg-[#6ba368]",
  wood: "bg-[#c89a5b]",
  bark: "bg-[#8a6b47]",
  sky: "bg-[#5b8dd9]",
  blue: "bg-blue-600",
  violet: "bg-violet-600",
  emerald: "bg-emerald-600",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  cyan: "bg-cyan-600",
  slate: "bg-slate-600",
  neutral: "bg-neutral-700",
};

export const WORKSPACE_COLOR_KEYS = Object.keys(WORKSPACE_COLORS);
export const DEFAULT_WORKSPACE_COLOR = "leaf";

/** Background class for a workspace colour token (falls back to the default). */
export function workspaceColorClass(color?: string | null): string {
  return WORKSPACE_COLORS[color ?? ""] ?? WORKSPACE_COLORS.leaf!;
}