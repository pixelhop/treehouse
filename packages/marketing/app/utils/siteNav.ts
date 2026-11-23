// The marketing site's navigation: four things in the header, with everything
// else one click down. Pure, so what each page offers is tested without Nuxt.
import { isLandingPath } from "./landing";

export interface SiteNavLink {
  label: string;
  to: string;
  /** One line under the label in a header menu. */
  description?: string;
}

export interface SiteNavGroup {
  label: string;
  links: SiteNavLink[];
  /** The group's own page, shown at the foot of its menu. */
  footer?: SiteNavLink;
}

export type SiteNavEntry = SiteNavLink | SiteNavGroup;

export function isNavGroup(entry: SiteNavEntry): entry is SiteNavGroup {
  return "links" in entry;
}

const OPEN_SOURCE_LABEL = "Open source";

const PRODUCT: SiteNavGroup = {
  label: "Product",
  links: [
    {
      label: "How it works",
      to: "/#workspace",
      description: "One folder, shared with everyone",
    },
    { label: "Features", to: "/#features", description: "Comments, sync, portals and themes" },
    { label: "Sharing", to: "/#sharing", description: "Links for clients, with no account needed" },
    {
      label: "For agents",
      to: "/#agents",
      description: "MCP, REST and a folder they know",
    },
    { label: "Second brain", to: "/#second-brain", description: "Notes an agent keeps filed" },
    { label: OPEN_SOURCE_LABEL, to: "/#open-source", description: "Down to the roots" },
  ],
};

const COMPARE: SiteNavGroup = {
  label: "Compare",
  links: [
    {
      label: "Obsidian",
      to: "/compare/obsidian",
      description: "Keep Obsidian, add your team and agents",
    },
    {
      label: "Notion",
      to: "/compare/notion",
      description: "A folder for agents, or a workspace API",
    },
    { label: "Fastio", to: "/compare/fastio", description: "Two shared workspaces, side by side" },
    {
      label: "Obsidian and Claude Code",
      to: "/guides/obsidian-and-claude-code-for-teams",
      description: "A guide to running it as a team",
    },
  ],
  footer: { label: "All comparisons", to: "/compare" },
};

const PRICING: SiteNavLink = { label: "Pricing", to: "/#pricing" };
const DOCS: SiteNavLink = { label: "Docs", to: "/docs" };

const withoutOpenSource = (links: SiteNavLink[]) =>
  links.filter((link) => link.label !== OPEN_SOURCE_LABEL);

/**
 * The header for a page. Comparison pages and guides make no open-source claim
 * while the repo is private, so their navigation mustn't make one for them.
 */
export function siteNavFor(path: string): SiteNavEntry[] {
  const product = isLandingPath(path)
    ? { ...PRODUCT, links: withoutOpenSource(PRODUCT.links) }
    : PRODUCT;
  return [product, COMPARE, PRICING, DOCS];
}

/** The footer's Product column: the same sections, plus Pricing. */
export function footerProductFor(path: string): SiteNavLink[] {
  const links = [...PRODUCT.links.slice(0, -1), PRICING, PRODUCT.links.at(-1)!];
  return isLandingPath(path) ? withoutOpenSource(links) : links;
}