/**
 * The example workspace behind the product demo on the home page.
 *
 * It is a company second brain — the shape a team actually ends up with once
 * they move a Notion-style home into files — because a demo full of
 * "Folder 1 / Untitled.md" teaches nobody what the thing is for.
 *
 * Everything here is display data. The demo renders the real app's chrome but
 * has no behaviour behind it, so there are no ids, no content types, and no
 * paths beyond what the tree needs to draw itself.
 */

export interface DemoNode {
  name: string;
  /** Emoji shown in place of the default folder/file glyph, as in the app. */
  icon?: string;
  isDir: boolean;
  children?: DemoNode[];
}

/**
 * The palettes offered by the switcher, mirroring THEME_PRESETS in the app's
 * `useTheme.ts`. Swatches are [app, surface, accent, fg] — the same four the
 * app's own theme picker previews with.
 */
export const DEMO_THEMES = [
  { id: "treehouse", label: "Treehouse", swatch: ["#f7f4ed", "#ffffff", "#2e7d5b", "#23372b"] },
  { id: "light", label: "Light", swatch: ["#fafafa", "#ffffff", "#2563eb", "#171717"] },
  { id: "dark", label: "Dark", swatch: ["#0a0a0a", "#171717", "#3b82f6", "#fafafa"] },
  { id: "dracula", label: "Dracula", swatch: ["#282a36", "#2f3140", "#bd93f9", "#f8f8f2"] },
  { id: "nord", label: "Nord", swatch: ["#2e3440", "#3b4252", "#88c0d0", "#eceff4"] },
  {
    id: "solarized-light",
    label: "Solarized",
    swatch: ["#fdf6e3", "#fbf6e9", "#268bd2", "#073642"],
  },
  { id: "rose-pine", label: "Rosé Pine", swatch: ["#191724", "#1f1d2e", "#c4a7e7", "#e0def4"] },
] as const;

export type DemoThemeId = (typeof DEMO_THEMES)[number]["id"];

/**
 * One folder is left open so the tree shows its own nesting. Everything else is
 * collapsed, which is how a workspace this size is actually read.
 */
export const demoTree: DemoNode[] = [
  { name: "AGENTS.md", isDir: false },
  { name: "README.md", isDir: false },
  { name: "Inbox", icon: "📥", isDir: true },
  { name: "About-Us", icon: "👋", isDir: true },
  {
    name: "Clients",
    icon: "🤝",
    isDir: true,
    children: [
      { name: "Harbour-Coffee", icon: "☕️", isDir: true },
      { name: "Meridian-Health", icon: "🩺", isDir: true },
      { name: "Northwind", icon: "🧭", isDir: true },
      { name: "onboarding-checklist.md", isDir: false },
    ],
  },
  { name: "Content-Marketing", icon: "📣", isDir: true },
  { name: "Design", icon: "🎨", isDir: true },
  { name: "Development", icon: "🛠️", isDir: true },
  { name: "Project-Management", icon: "🎯", isDir: true },
  { name: "Resources", icon: "📦", isDir: true },
  { name: "Strategy", icon: "🧭", isDir: true },
  { name: "Ways-of-Working", icon: "🏖️", isDir: true },
  { name: "_templates", isDir: true },
  { name: "MAP.md", isDir: false },
];

/** Paths (by name — the demo tree is shallow) drawn in the expanded state. */
export const demoExpanded = new Set(["Clients"]);

/** The rows of the README's "map" table. */
export const demoMap = [
  { icon: "📥", name: "Inbox", blurb: "Dump anything here, unsorted. Triaged later." },
  { icon: "👋", name: "About Us", blurb: "Who we are, what we value, who does what." },
  { icon: "🏖️", name: "Ways of Working", blurb: "Benefits, holiday, meetings, remote, tracking." },
  { icon: "🎯", name: "Project Management", blurb: "Planning, comms, tasks, projects, sprints." },
  { icon: "🛠️", name: "Development", blurb: "Best practices, tech, research, libraries." },
  { icon: "🤝", name: "Clients", blurb: "Everything, per client." },
];