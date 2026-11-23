import { describe, expect, it } from "vite-plus/test";
import {
  activeTocId,
  buildDocsTree,
  DOCS_AREAS,
  DOCS_TITLE_SUFFIX,
  docsAreaForPath,
  docsAreaTree,
  docsBreadcrumbs,
  docsParentPath,
  docsPrevNext,
  docsRelease,
  docsTocHeadings,
  docsTocIds,
  findDocsNode,
  flattenDocsTree,
  isIgnoredDocPath,
  isListedDoc,
  normalizeDocsPath,
  resolveRelatedDocs,
  type DocsPageMeta,
} from "../../app/utils/docs-tree";

const PAGES: DocsPageMeta[] = [
  { path: "/docs", title: "Treehouse docs", type: "hub", position: 0 },
  { path: "/docs/channels", title: "Channels", type: "hub", position: 6 },
  { path: "/docs/get-started", title: "Get started", type: "hub", position: 1 },
  {
    path: "/docs/get-started/build-your-first-bot",
    title: "Build your first bot",
    navTitle: "First bot",
    description: "From zero to a working bot.",
    position: 2,
  },
  {
    path: "/docs/get-started/how-chat-thing-works",
    title: "How Treehouse works",
    position: 1,
  },
  {
    path: "/docs/channels/website",
    title: "Website widget",
    type: "hub",
    position: 1,
  },
  {
    path: "/docs/channels/website/install",
    title: "Install the widget",
    position: 1,
  },
  {
    path: "/docs/channels/website/branding",
    title: "Remove Treehouse branding",
    navTitle: "Branding",
    position: 2,
  },
  { path: "/docs/channels/whatsapp", title: "WhatsApp", position: 3 },
  {
    path: "/docs/channels/phone",
    title: "Phone",
    position: 2,
    release: "early-access",
  },
  {
    path: "/docs/channels/secret",
    title: "Secret",
    position: 4,
    release: "unreleased",
  },
  { path: "/docs/bots/_index", title: "Legacy", position: 0 },
  { path: "/docs/agents", title: "Agents", type: "hub", position: 9 },
  { path: "/docs/agents/chat-api", title: "Chat API", position: 1 },
  { path: "/docs/agents/webhooks", title: "Webhooks", position: 2 },
  { path: "/docs/mcp", title: "AI assistants (MCP)", type: "hub", position: 8 },
];

describe("path helpers", () => {
  it("normalizes trailing slashes, query, hash and .md", () => {
    expect(normalizeDocsPath("/docs/")).toBe("/docs");
    expect(normalizeDocsPath("/docs/knowledge/?q=x#y")).toBe("/docs/knowledge");
    expect(normalizeDocsPath("/docs/knowledge.md")).toBe("/docs/knowledge");
  });

  it("finds the parent hub path", () => {
    expect(docsParentPath("/docs/channels/website/install")).toBe("/docs/channels/website");
    expect(docsParentPath("/docs/channels")).toBe("/docs");
    expect(docsParentPath("/docs")).toBeNull();
  });

  it("ignores legacy underscore files", () => {
    expect(isIgnoredDocPath("/docs/bots/_index")).toBe(true);
    expect(isIgnoredDocPath("/docs/bots/analytics")).toBe(false);
  });
});

describe("release stages", () => {
  it("defaults to public and only lists public pages", () => {
    expect(docsRelease({})).toBe("public");
    expect(docsRelease({ release: "bogus" })).toBe("public");
    expect(isListedDoc({ release: "early-access" })).toBe(false);
    expect(isListedDoc({ release: "unreleased" })).toBe(false);
    expect(isListedDoc({ release: "public" })).toBe(true);
  });
});

describe("buildDocsTree", () => {
  const tree = buildDocsTree(PAGES);

  it("orders sections by hub position", () => {
    expect(tree.children.map((n) => n.path)).toEqual([
      "/docs/get-started",
      "/docs/channels",
      "/docs/mcp",
      "/docs/agents",
    ]);
  });

  it("orders pages by position and labels them navTitle || title", () => {
    const getStarted = tree.children[0];
    expect(getStarted?.children.map((n) => n.label)).toEqual(["How Treehouse works", "First bot"]);
  });

  it("nests the website sub-section and marks it as a hub", () => {
    const website = findDocsNode(tree, "/docs/channels/website");
    expect(website?.isHub).toBe(true);
    expect(website?.children.map((n) => n.label)).toEqual(["Install the widget", "Branding"]);
  });

  it("leaves out early-access, unreleased and legacy pages", () => {
    const paths = flattenDocsTree(tree).map((n) => n.path);
    expect(paths).not.toContain("/docs/channels/phone");
    expect(paths).not.toContain("/docs/channels/secret");
    expect(paths).not.toContain("/docs/bots/_index");
  });
});

describe("areas", () => {
  const tree = buildDocsTree(PAGES);
  const docs = DOCS_AREAS.find((area) => area.key === "docs")!;
  const agents = DOCS_AREAS.find((area) => area.key === "agents")!;

  it("puts the agents section in Agents and everything else in Docs", () => {
    expect(docsAreaForPath("/docs/agents").key).toBe("agents");
    expect(docsAreaForPath("/docs/agents/chat-api/").key).toBe("agents");
    expect(docsAreaForPath("/docs/agents/chat-api.md").key).toBe("agents");
    expect(docsAreaForPath("/docs").key).toBe("docs");
    expect(docsAreaForPath("/docs/mcp").key).toBe("docs");
    expect(docsAreaForPath("/docs/channels/website/install").key).toBe("docs");
    // A section no area lists falls back to Docs.
    expect(docsAreaForPath("/docs/brand-new-section/page").key).toBe("docs");
  });

  it("roots each area at its home", () => {
    expect(docs.home).toBe("/docs");
    expect(agents.home).toBe("/docs/agents");
  });

  it("gives the Docs area every section except agents (MCP included)", () => {
    const area = docsAreaTree(tree, docs);
    expect(area.path).toBe("/docs");
    expect(area.children.map((n) => n.path)).toEqual([
      "/docs/get-started",
      "/docs/channels",
      "/docs/mcp",
    ]);
    // The full tree is untouched.
    expect(tree.children).toHaveLength(4);
  });

  it("roots the Agents area at its hub, so its pages are the whole sidebar", () => {
    const area = docsAreaTree(tree, agents);
    expect(area.path).toBe("/docs/agents");
    expect(area.children.map((n) => n.path)).toEqual([
      "/docs/agents/chat-api",
      "/docs/agents/webhooks",
    ]);
  });

  it("returns an empty area when its hub is not listed", () => {
    const area = docsAreaTree(
      buildDocsTree(PAGES.filter((p) => p.path !== "/docs/agents")),
      agents,
    );
    expect(area.path).toBe("/docs/agents");
    expect(area.children).toEqual([]);
  });
});

describe("docsPrevNext", () => {
  const tree = buildDocsTree(PAGES);
  const order = flattenDocsTree(docsAreaTree(tree, docsAreaForPath("/docs")));
  const devOrder = flattenDocsTree(docsAreaTree(tree, docsAreaForPath("/docs/agents")));

  it("walks the tree in reading order, across sections and into sub-sections", () => {
    expect(order.map((n) => n.path)).toEqual([
      "/docs",
      "/docs/get-started",
      "/docs/get-started/how-chat-thing-works",
      "/docs/get-started/build-your-first-bot",
      "/docs/channels",
      "/docs/channels/website",
      "/docs/channels/website/install",
      "/docs/channels/website/branding",
      "/docs/channels/whatsapp",
      "/docs/mcp",
    ]);
  });

  it("stays within an area", () => {
    expect(devOrder.map((n) => n.path)).toEqual([
      "/docs/agents",
      "/docs/agents/chat-api",
      "/docs/agents/webhooks",
    ]);
    expect(docsPrevNext(devOrder, "/docs/agents").prev).toBeNull();
    expect(docsPrevNext(devOrder, "/docs/agents/webhooks").next).toBeNull();
    expect(docsPrevNext(order, "/docs/mcp").next).toBeNull();
  });

  it("returns neighbours", () => {
    const { prev, next } = docsPrevNext(order, "/docs/channels/website/branding");
    expect(prev?.path).toBe("/docs/channels/website/install");
    expect(next?.path).toBe("/docs/channels/whatsapp");
  });

  it("gives unlisted pages no neighbours", () => {
    expect(docsPrevNext(order, "/docs/channels/phone")).toEqual({
      prev: null,
      next: null,
    });
  });
});

describe("docsBreadcrumbs", () => {
  it("builds the trail from the docs home", () => {
    expect(docsBreadcrumbs(PAGES, "/docs/channels/website/branding")).toEqual([
      { name: "Docs", url: "/docs" },
      { name: "Channels", url: "/docs/channels" },
      { name: "Website widget", url: "/docs/channels/website" },
      { name: "Branding", url: "/docs/channels/website/branding" },
    ]);
  });

  it("starts at the Agents area home, without a Docs crumb", () => {
    expect(docsBreadcrumbs(PAGES, "/docs/agents/chat-api")).toEqual([
      { name: "Agents", url: "/docs/agents" },
      { name: "Chat API", url: "/docs/agents/chat-api" },
    ]);
    // The area home is the root of its own trail, so it has no trail to show.
    expect(docsBreadcrumbs(PAGES, "/docs/agents")).toEqual([
      { name: "Agents", url: "/docs/agents" },
    ]);
  });

  it("still shows the real location of an early-access page", () => {
    expect(docsBreadcrumbs(PAGES, "/docs/channels/phone").map((c) => c.url)).toEqual([
      "/docs",
      "/docs/channels",
      "/docs/channels/phone",
    ]);
  });
});

describe("resolveRelatedDocs", () => {
  it("resolves titles + descriptions and skips missing paths", () => {
    expect(
      resolveRelatedDocs(PAGES, ["/docs/get-started/build-your-first-bot", "/docs/nope"]),
    ).toEqual([
      {
        path: "/docs/get-started/build-your-first-bot",
        title: "Build your first bot",
        description: "From zero to a working bot.",
      },
    ]);
  });
});

describe("docsTocHeadings", () => {
  it("maps content toc links", () => {
    expect(docsTocHeadings([{ id: "a", text: "A", children: [{ id: "b", text: "B" }] }])).toEqual([
      {
        id: "a",
        title: "A",
        children: [{ id: "b", title: "B", children: [] }],
      },
    ]);
  });
});

describe("DOCS_TITLE_SUFFIX", () => {
  it("uses a plain hyphen, never an em or en dash", () => {
    expect(DOCS_TITLE_SUFFIX).toBe(" - Treehouse Docs");
    expect(DOCS_TITLE_SUFFIX).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("docsTocIds", () => {
  it("lists each heading, then its children, in reading order", () => {
    expect(
      docsTocIds([
        {
          id: "a",
          title: "A",
          children: [
            { id: "a1", title: "A1", children: [] },
            { id: "a2", title: "A2", children: [] },
          ],
        },
        { id: "b", title: "B", children: [] },
      ]),
    ).toEqual(["a", "a1", "a2", "b"]);
  });
});

describe("activeTocId", () => {
  const ids = ["intro", "setup", "usage"];
  const tops = (positions: Record<string, number | null>) => (id: string) => positions[id] ?? null;

  it("is the first heading before any has scrolled past the offset", () => {
    expect(activeTocId(ids, tops({ intro: 300, setup: 900, usage: 1500 }), 120)).toBe("intro");
  });

  it("is the last heading at or above the offset", () => {
    expect(activeTocId(ids, tops({ intro: -800, setup: 120, usage: 700 }), 120)).toBe("setup");
    expect(activeTocId(ids, tops({ intro: -800, setup: -300, usage: 40 }), 120)).toBe("usage");
  });

  it("skips headings missing from the page", () => {
    expect(activeTocId(ids, tops({ intro: -500, setup: null, usage: 900 }), 120)).toBe("intro");
  });

  it("is empty with no headings", () => {
    expect(activeTocId([], () => 0, 120)).toBe("");
  });
});