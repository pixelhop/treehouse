/**
 * The markdown twins agents read (`/docs/<path>.md`, `/llms-docs.txt`) must be
 * plain markdown: no MDC syntax, no component tags, absolute links.
 */
import { describe, expect, it } from "vite-plus/test";
import type { DocsPageMeta } from "../../app/utils/docs-tree";
import { buildLlmsIndex, docsLlmsSections } from "../../server/utils/docs-llms";
import { renderDocsTwin, type MinimarkNode } from "../../server/utils/docs-markdown";
import { docsPrefersMarkdown } from "../../server/utils/docs-negotiation";

const SITE = { siteUrl: "https://trytree.house" };

const PAGES: DocsPageMeta[] = [
  { path: "/docs", title: "Treehouse docs", type: "hub", position: 0 },
  {
    path: "/docs/agents",
    title: "Agents",
    type: "hub",
    position: 5,
    description: "Connect agents.",
  },
  {
    path: "/docs/agents/api-keys",
    title: "Manage API keys",
    type: "how-to",
    position: 4,
    description: "Create and revoke keys.",
  },
  {
    path: "/docs/agents/connect-claude-code",
    title: "Connect Claude Code",
    type: "how-to",
    position: 2,
    description: "Give Claude Code access.",
    related: ["/docs/agents/api-keys"],
  },
];

const body = (...value: MinimarkNode[]) => ({ type: "minimark", value });

describe("renderDocsTwin", () => {
  const twin = renderDocsTwin(
    {
      ...PAGES[3]!,
      body: body(
        ["h2", { id: "steps" }, "Steps"],
        [
          "p",
          {},
          "Open ",
          ["strong", {}, "API keys"],
          " and see ",
          ["a", { href: "/docs/agents/api-keys" }, "keys"],
          ".",
        ],
        [
          "callout",
          { type: "agent", title: "For you" },
          ["p", {}, "Read ", ["code", {}, "AGENTS.md"], " first."],
        ],
        [
          "quick-links",
          {},
          ["quick-link", { title: "Agents", href: "/docs/agents", description: "Connect agents." }],
        ],
        ["pre", { language: "bash", filename: "terminal", code: "claude mcp add treehouse\n" }],
        ["p", {}, ["img", { src: "/docs/images/api-keys.webp", alt: "The API keys dialog" }]],
      ),
    },
    PAGES,
    SITE,
  );

  it("starts with the title and the description", () => {
    expect(twin.startsWith("# Connect Claude Code\n\nGive Claude Code access.\n")).toBe(true);
  });

  it("flattens components into plain markdown", () => {
    expect(twin).toContain("> **For you**\n>\n> Read `AGENTS.md` first.");
    expect(twin).toContain("- [Agents](https://trytree.house/docs/agents): Connect agents.");
    expect(twin).toContain("**terminal**\n\n```bash\nclaude mcp add treehouse\n```");
    expect(twin).not.toMatch(/::|<callout|<quick-link/);
  });

  it("makes links and images absolute", () => {
    expect(twin).toContain("[keys](https://trytree.house/docs/agents/api-keys)");
    expect(twin).toContain(
      "![The API keys dialog](https://trytree.house/docs/images/api-keys.webp)",
    );
  });

  it("appends related pages", () => {
    expect(twin).toContain(
      "## Related\n\n- [Manage API keys](https://trytree.house/docs/agents/api-keys): Create and revoke keys.",
    );
  });

  it("lists a hub's children", () => {
    const hub = renderDocsTwin({ ...PAGES[1]!, body: body(["p", {}, "Intro."]) }, PAGES, SITE);
    expect(hub).toContain("## In this section");
    expect(hub.indexOf("Connect Claude Code")).toBeLessThan(hub.indexOf("Manage API keys"));
  });
});

describe("buildLlmsIndex", () => {
  it("puts the agent facts before the sections and links to twins", () => {
    const index = buildLlmsIndex(
      {
        title: "Treehouse",
        description: "A workspace.",
        url: "https://trytree.house",
        details: "Start here.",
      },
      docsLlmsSections(PAGES),
    );
    expect(index).toMatch(
      /^# Treehouse\n\n> A workspace\.\n\nCanonical Origin: https:\/\/trytree\.house\n\nStart here\.\n\n## Agents/,
    );
    expect(index).toContain(
      "- [Connect Claude Code](https://trytree.house/docs/agents/connect-claude-code.md): Give Claude Code access.",
    );
  });
});
describe("docsPrefersMarkdown", () => {
  it.each([
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/html, text/markdown;q=0.5", false],
    ["text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", false],
    ["*/*", false],
    ["", false],
  ])("%s -> %s", (accept, expected) => {
    expect(docsPrefersMarkdown(accept)).toBe(expected);
  });
});