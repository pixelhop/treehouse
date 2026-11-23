import { describe, expect, it } from "vite-plus/test";
import {
  availableFields,
  type BoardCard,
  boardColor,
  cardFields,
  fieldColor,
  serializeCardFields,
  serializeColumns,
  withFieldColor,
  withFieldShown,
  boardDeclarationPatch,
  buildBoard,
  cardFileName,
  cardStatus,
  checklistCounts,
  decideMove,
  declaredColumns,
  effectiveDropIndex,
  assigneeInitials,
  newBoardReadme,
  orderForDrop,
  resolveAssignee,
  toBoardCard,
  toggledAssignee,
} from "../app/utils/board";
import { parseFrontMatter } from "../app/utils/frontmatterData";
import { splitFrontMatter } from "../app/utils/frontmatter";
import { boardAvailable, resolveDefaultView } from "../app/utils/treehouse";

const card = (name: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  path: `roadmap/${name}.md`,
  name: `${name}.md`,
  status: null,
  order: null,
  fields: {},
  due: null,
  assignees: [],
  checklist: null,
  conflicted: false,
  ...extra,
});

const cols = (...names: string[]) => names.map((name) => ({ name, color: null }));

describe("cardStatus", () => {
  it("accepts trimmed strings and numbers", () => {
    expect(cardStatus(" doing ")).toBe("doing");
    expect(cardStatus(2)).toBe("2");
  });

  it("treats empty and non-scalar values as no status", () => {
    expect(cardStatus("")).toBeNull();
    expect(cardStatus("   ")).toBeNull();
    expect(cardStatus(["doing"])).toBeNull();
    expect(cardStatus({ a: 1 })).toBeNull();
    expect(cardStatus(true)).toBeNull();
    expect(cardStatus(undefined)).toBeNull();
  });
});

describe("checklistCounts", () => {
  it("counts open and done task-list items", () => {
    const body = "Intro\n\n- [x] API param\n- [ ] UI chips\n* [X] Docs\n+ [ ] Ship\n";
    expect(checklistCounts(body)).toEqual({ done: 2, total: 4 });
  });

  it("ignores task syntax inside fenced code", () => {
    const body = "- [ ] real\n```md\n- [x] example\n```\n";
    expect(checklistCounts(body)).toEqual({ done: 0, total: 1 });
  });

  it("returns null when there is no checklist", () => {
    expect(checklistCounts("Just prose.\n- a plain bullet\n")).toBeNull();
  });
});

describe("toBoardCard", () => {
  it("reads every card field from front matter and body", () => {
    const got = toBoardCard(
      { path: "roadmap/search.md", name: "search.md" },
      {
        title: "Search filters",
        status: "doing",
        order: 1.5,
        tags: ["search", "ux"],
        due: "2026-10-14",
        assignee: "Zef",
      },
      "- [x] a\n- [ ] b\n",
    );
    expect(got).toEqual({
      path: "roadmap/search.md",
      name: "search.md",
      title: "Search filters",
      status: "doing",
      order: 1.5,
      fields: { tags: ["search", "ux"] },
      due: "2026-10-14",
      assignees: ["Zef"],
      checklist: { done: 1, total: 2 },
      conflicted: false,
    });
  });

  it("falls back to date for the due chip, and tolerates missing front matter", () => {
    expect(toBoardCard({ path: "a.md", name: "a.md" }, { date: "2026-10-01" }, "").due).toBe(
      "2026-10-01",
    );
    const bare = toBoardCard({ path: "a.md", name: "a.md", conflicted: true }, null, "");
    expect(bare.status).toBeNull();
    expect(bare.order).toBeNull();
    expect(bare.conflicted).toBe(true);
  });

  it("ignores a non-numeric order and a blank title", () => {
    const got = toBoardCard({ path: "a.md", name: "a.md" }, { order: "first", title: " " }, "");
    expect(got.order).toBeNull();
    expect(got.title).toBeUndefined();
  });
});

describe("declaredColumns", () => {
  it("reads a list, de-duplicating case-insensitively", () => {
    expect(declaredColumns({ columns: ["To do", "Doing", "doing", " Done "] })).toEqual([
      { name: "To do", color: null },
      { name: "Doing", color: null },
      { name: "Done", color: null },
    ]);
  });

  it("is null when absent or not a list", () => {
    expect(declaredColumns(null)).toBeNull();
    expect(declaredColumns({})).toBeNull();
    expect(declaredColumns({ columns: "To do" })).toBeNull();
  });

  it("is an empty list when declared empty", () => {
    expect(declaredColumns({ columns: [] })).toEqual([]);
  });
});

describe("buildBoard", () => {
  it("places cards in declared columns, matching status case-insensitively", () => {
    const board = buildBoard(
      [card("a", { status: "doing" }), card("b", { status: "Done" })],
      cols("Backlog", "Doing", "Done"),
    );
    expect(board.columns.map((c) => [c.label, c.declared, c.cards.map((x) => x.name)])).toEqual([
      ["Backlog", true, []],
      ["Doing", true, ["a.md"]],
      ["Done", true, ["b.md"]],
    ]);
    expect(board.unsorted).toEqual([]);
  });

  it("gives an undeclared status its own column after the declared ones", () => {
    const board = buildBoard([card("a", { status: "blocked" })], cols("Doing"));
    expect(board.columns.map((c) => [c.label, c.declared])).toEqual([
      ["Doing", true],
      ["blocked", false],
    ]);
  });

  it("derives columns without a declaration, all treated as declared", () => {
    const board = buildBoard(
      [card("b", { status: "review" }), card("a", { status: "doing" })],
      null,
    );
    expect(board.columns.map((c) => [c.label, c.declared])).toEqual([
      ["doing", true],
      ["review", true],
    ]);
  });

  it("collects cards without a status into the unsorted lane", () => {
    const board = buildBoard([card("a"), card("b", { status: "doing" })], cols("Doing"));
    expect(board.unsorted.map((c) => c.name)).toEqual(["a.md"]);
  });

  it("sorts arranged cards by order, then the rest by title", () => {
    const board = buildBoard(
      [
        card("zeta", { status: "doing" }),
        card("alpha", { status: "doing" }),
        card("second", { status: "doing", order: 2 }),
        card("first", { status: "doing", order: 1 }),
      ],
      cols("Doing"),
    );
    expect(board.columns[0]!.cards.map((c) => c.name)).toEqual([
      "first.md",
      "second.md",
      "alpha.md",
      "zeta.md",
    ]);
  });
});

describe("orderForDrop / effectiveDropIndex", () => {
  const column = [
    card("a", { order: 1 }),
    card("b", { order: 2 }),
    card("c"), // unarranged tail
    card("d"),
  ];

  it("places a card between arranged neighbours", () => {
    expect(orderForDrop(column, 1)).toBe(1.5);
  });

  it("places a card before the first or after the last arranged card", () => {
    expect(orderForDrop(column, 0)).toBe(0);
    expect(orderForDrop(column, 2)).toBe(3);
  });

  it("snaps a drop inside the unarranged tail to the end of the arranged run", () => {
    expect(effectiveDropIndex(column, 4)).toBe(2);
    expect(orderForDrop(column, 4)).toBe(3);
  });

  it("starts at 1 in a column with nothing arranged", () => {
    expect(effectiveDropIndex([card("x"), card("y")], 2)).toBe(0);
    expect(orderForDrop([card("x"), card("y")], 2)).toBe(1);
    expect(orderForDrop([], 0)).toBe(1);
  });
});

describe("decideMove", () => {
  const base = {
    canMove: true,
    dragPath: "roadmap/a.md",
    card: card("a", { status: "Doing", order: 1 }),
    toStatus: "Done",
    toOrder: null,
    inFlight: false,
  };

  it("proceeds on a column change", () => {
    expect(decideMove(base)).toEqual({ proceed: true, path: "roadmap/a.md" });
  });

  it("proceeds on a reorder within a column", () => {
    expect(decideMove({ ...base, toStatus: "doing", toOrder: 3 }).proceed).toBe(true);
  });

  it("blocks a read-only board, an unchanged drop and a drop while in flight", () => {
    expect(decideMove({ ...base, canMove: false })).toEqual({
      proceed: false,
      reason: "read-only",
    });
    expect(decideMove({ ...base, toStatus: "doing", toOrder: 1 })).toEqual({
      proceed: false,
      reason: "no-change",
    });
    expect(decideMove({ ...base, inFlight: true })).toEqual({
      proceed: false,
      reason: "in-flight",
    });
    expect(decideMove({ ...base, card: undefined })).toEqual({
      proceed: false,
      reason: "unknown-card",
    });
  });

  it("treats a drop into No status from No status as no change", () => {
    const unsorted = card("a");
    expect(decideMove({ ...base, card: unsorted, toStatus: null }).proceed).toBe(false);
  });
});

describe("assignees", () => {
  const members = [
    { id: "u1", name: "Zef Maxted", image: null },
    { id: "u2", name: "Rich Smith", image: "https://example.test/r.png" },
    { id: "u3", name: "Rich Jones", image: null },
  ];

  it("resolves by id, full name, or a unique first name", () => {
    expect(resolveAssignee("u2", members)?.id).toBe("u2");
    expect(resolveAssignee("zef maxted", members)?.id).toBe("u1");
    expect(resolveAssignee("Zef", members)?.id).toBe("u1");
  });

  it("leaves ambiguous and unknown names unresolved", () => {
    expect(resolveAssignee("Rich", members)).toBeNull();
    expect(resolveAssignee("claude", members)).toBeNull();
    expect(resolveAssignee(" ", members)).toBeNull();
  });

  it("makes initials", () => {
    expect(assigneeInitials("claude")).toBe("CL");
    expect(assigneeInitials("Priya Shah")).toBe("PS");
    expect(assigneeInitials("research-agent")).toBe("RA");
  });

  it("toggles a name, writing a string for one and a list for several", () => {
    expect(toggledAssignee([], "Zef")).toBe("Zef");
    expect(toggledAssignee(["Zef"], "Rich")).toEqual(["Zef", "Rich"]);
    expect(toggledAssignee(["Zef", "Rich"], "zef")).toBe("Rich");
    expect(toggledAssignee(["Zef"], "Zef")).toBeUndefined();
  });

  it("unassigns a member written by first name when toggled by full name", () => {
    expect(toggledAssignee(["Zef", "claude"], "Zef Maxted", members)).toBe("claude");
  });
});

describe("cardFileName", () => {
  it("slugifies the title and avoids existing names case-insensitively", () => {
    expect(cardFileName("Search filters!", [])).toBe("search-filters.md");
    expect(cardFileName("Search filters", ["Search-Filters.md", "search-filters-2.md"])).toBe(
      "search-filters-3.md",
    );
    expect(cardFileName("!!!", [])).toBe("card.md");
  });
});

describe("board declaration", () => {
  it("adds view and seeds columns from existing statuses", () => {
    expect(boardDeclarationPatch({ title: "Roadmap" }, ["doing", "done"])).toEqual({
      view: "board",
      columns: ["doing", "done"],
    });
  });

  it("falls back to the default columns, and keeps a declared list", () => {
    expect(boardDeclarationPatch(null, [])).toEqual({
      view: "board",
      columns: ["To do", "Doing", "Done"],
    });
    expect(boardDeclarationPatch({ columns: ["A"] }, ["b"])).toEqual({ view: "board" });
  });

  it("writes a new board README that declares itself", async () => {
    const source = await newBoardReadme("Launch plan");
    const fm = parseFrontMatter(splitFrontMatter(source).frontMatter);
    expect(fm).toEqual({
      title: "Launch plan",
      view: "board",
      columns: ["To do", "Doing", "Done"],
    });
    expect(splitFrontMatter(source).body).toContain("status");
  });
});

describe("board discovery", () => {
  it("is offered by statuses alone or by a declaration", () => {
    expect(boardAvailable(null, true)).toBe(true);
    expect(boardAvailable({ view: "board" }, false)).toBe(true);
    expect(boardAvailable({ view: "calendar" }, false)).toBe(false);
  });

  it("opens on a declared board even with no cards", () => {
    expect(resolveDefaultView({ view: "board" }, false)).toBe("board");
    expect(resolveDefaultView({ title: "x" }, false)).toBe("default");
  });
});
describe("colours", () => {
  it("accepts palette names in any case, and grey for gray", () => {
    expect(boardColor("Blue")).toBe("blue");
    expect(boardColor(" grey ")).toBe("gray");
    expect(boardColor("teal")).toBeNull();
    expect(boardColor(3)).toBeNull();
  });

  it("reads a coloured column and ignores an unknown colour", () => {
    expect(
      declaredColumns({
        columns: ["Ideas", { name: "Filming", color: "orange" }, { name: "Edit", color: "teal" }],
      }),
    ).toEqual([
      { name: "Ideas", color: null },
      { name: "Filming", color: "orange" },
      { name: "Edit", color: null },
    ]);
  });

  it("skips a column map without a name", () => {
    expect(declaredColumns({ columns: [{ color: "red" }, "Done"] })).toEqual([
      { name: "Done", color: null },
    ]);
  });

  it("writes a plain name unless the column has a colour", () => {
    expect(
      serializeColumns([
        { name: "Ideas", color: null },
        { name: "Filming", color: "orange" },
      ]),
    ).toEqual(["Ideas", { name: "Filming", color: "orange" }]);
  });

  it("colours a column on the board", () => {
    const board = buildBoard([], [{ name: "Filming", color: "orange" }]);
    expect(board.columns[0]!.color).toBe("orange");
  });
});

describe("card fields", () => {
  it("shows tags by default, and exactly what the README picks once it does", () => {
    expect(cardFields(null)).toEqual([{ name: "tags", colors: {} }]);
    expect(cardFields({ card_fields: [] })).toEqual([]);
    expect(
      cardFields({
        card_fields: ["project", { name: "company", colors: { Acme: "blue", Beta: "nope" } }],
      }),
    ).toEqual([
      { name: "project", colors: {} },
      { name: "company", colors: { Acme: "blue" } },
    ]);
  });

  it("never offers keys the board already places, and drops duplicates", () => {
    expect(cardFields({ card_fields: ["status", "due", "company", "company"] })).toEqual([
      { name: "company", colors: {} },
    ]);
  });

  it("round-trips through front matter", () => {
    const fields = cardFields({
      card_fields: ["project", { name: "company", colors: { Acme: "blue" } }],
    });
    expect(serializeCardFields(fields)).toEqual([
      "project",
      { name: "company", colors: { Acme: "blue" } },
    ]);
  });

  it("matches a value's colour ignoring case", () => {
    const field = { name: "company", colors: { Acme: "blue" as const } };
    expect(fieldColor(field, "acme")).toBe("blue");
    expect(fieldColor(field, "Northwind")).toBeNull();
  });

  it("sets, recolours and clears a value's colour, keeping its spelling", () => {
    let fields = [{ name: "company", colors: {} }];
    fields = withFieldColor(fields, "company", "Acme", "blue");
    fields = withFieldColor(fields, "company", "ACME", "green");
    expect(fields).toEqual([{ name: "company", colors: { Acme: "green" } }]);
    expect(withFieldColor(fields, "company", "acme", null)).toEqual([
      { name: "company", colors: {} },
    ]);
  });

  it("shows and hides a field", () => {
    const shown = withFieldShown([{ name: "tags", colors: {} }], "company", true);
    expect(shown.map((f) => f.name)).toEqual(["tags", "company"]);
    expect(withFieldShown(shown, "tags", false).map((f) => f.name)).toEqual(["company"]);
  });

  it("keeps a hidden field's colours, and brings them back when shown", () => {
    const coloured = [{ name: "platform", colors: { TikTok: "purple" as const } }];
    const hidden = withFieldShown(coloured, "platform", false);
    expect(hidden).toEqual([{ name: "platform", colors: { TikTok: "purple" }, hidden: true }]);
    expect(serializeCardFields(hidden)).toEqual([
      { name: "platform", colors: { TikTok: "purple" }, hidden: true },
    ]);
    expect(cardFields({ card_fields: serializeCardFields(hidden) })).toEqual(hidden);
    expect(withFieldShown(hidden, "platform", true)).toEqual(coloured);
  });

  it("puts every other front-matter key on the card, as strings", () => {
    const got = toBoardCard(
      { path: "a.md", name: "a.md" },
      {
        title: "A",
        status: "Doing",
        company: "Acme",
        episode: 3,
        platforms: ["TikTok", "Reels"],
        draft: true,
      },
      "",
    );
    expect(got.fields).toEqual({
      company: ["Acme"],
      episode: ["3"],
      platforms: ["TikTok", "Reels"],
    });
  });

  it("lists the fields a board could show, with counts and distinct values", () => {
    const cards = [
      card("a", { fields: { company: ["Acme"], tags: ["web"] } }),
      card("b", { fields: { company: ["acme", "Northwind"] } }),
    ];
    expect(availableFields(cards, [{ name: "project", colors: {} }])).toEqual([
      { name: "company", count: 2, values: ["Acme", "Northwind"] },
      { name: "project", count: 0, values: [] },
      { name: "tags", count: 1, values: ["web"] },
    ]);
  });
});