// Pure logic behind a folder's Board view: turning each markdown child's front
// matter into a card, arranging cards into columns, and working out what a drag
// should write. The IO (reading each child, writing the patched file) lives in
// useFolderFrontMatter / useBoardActions; everything here is pure so it can be
// unit-tested directly.
//
// The board is the calendar's twin. A card's column is its `status` front-matter
// value, the column list and its order come from `columns` in the folder's
// README, and a card's place within a column is an optional numeric `order`.
// Everything is a plain front-matter key, so an agent moves a card by editing
// one line of a file.
//
// The README can also colour columns and choose which other front-matter keys
// show as chips on each card. A `columns` or `card_fields` entry is either a
// plain name or a small map carrying its colour settings:
//
//   columns:
//     - Ideas
//     - name: Filming
//       color: orange
//   card_fields:
//     - name: company
//       colors: { Acme: blue, Northwind: green }
//     - project
import { withoutMarkdownExtension } from "shared";
import { toDateKey } from "./calendar";
import type { FrontMatterData } from "./frontmatterData";
import { loadFrontMatterData } from "./frontmatterFields";
import { slugify } from "./slug";

/** Columns a new board starts with when nothing else says otherwise. */
export const DEFAULT_COLUMNS = ["To do", "Doing", "Done"] as const;

/**
 * The colours a column or chip can take. Deliberately few, and named the way
 * people (and agents) would guess: Notion's set. Each is one mid-tone; the
 * components mix it with the theme's own surface and text colours, so the same
 * name reads well on every theme, light or dark.
 */
export const BOARD_COLORS = {
  gray: "#8a8f98",
  brown: "#9a6b4b",
  orange: "#e0823d",
  yellow: "#d4a72c",
  green: "#3e8e5e",
  blue: "#4a7fd6",
  purple: "#8b64c9",
  pink: "#d0609a",
  red: "#c9503f",
} as const;
export type BoardColor = keyof typeof BOARD_COLORS;
export const BOARD_COLOR_NAMES = Object.keys(BOARD_COLORS) as BoardColor[];

/** A colour name as written in front matter, or null when it isn't one of ours. */
export function boardColor(value: unknown): BoardColor | null {
  if (typeof value !== "string") return null;
  const name = value
    .trim()
    .toLowerCase()
    .replace(/^grey$/, "gray");
  return name in BOARD_COLORS ? (name as BoardColor) : null;
}

/**
 * Inline styles for a coloured chip, column and swatch dot. Mixed with the
 * theme's own variables rather than fixed light-mode tints, so a colour reads
 * on every theme.
 */
export function chipStyle(color: BoardColor): Record<string, string> {
  const hex = BOARD_COLORS[color];
  return {
    backgroundColor: `color-mix(in srgb, ${hex} 20%, transparent)`,
    color: `color-mix(in srgb, ${hex} 65%, var(--th-fg))`,
  };
}
export function columnStyle(color: BoardColor): Record<string, string> {
  return {
    backgroundColor: `color-mix(in srgb, ${BOARD_COLORS[color]} 14%, var(--th-surface-2))`,
  };
}
export function dotStyle(color: BoardColor): Record<string, string> {
  return { backgroundColor: BOARD_COLORS[color] };
}

/** A declared column: its name, and its colour when one is set. */
export interface ColumnSpec {
  name: string;
  color: BoardColor | null;
}

/** A front-matter key shown as chips on every card, with colours for its values. */
export interface FieldSpec {
  name: string;
  /** Value → colour, keyed as written. Look values up with `fieldColor`. */
  colors: Record<string, BoardColor>;
  /** Turned off in the Fields panel, but kept so its colours survive. */
  hidden?: boolean;
}

/**
 * Keys the board already gives a place of their own (title, column, order, due
 * date, assignees), so they're never offered as chips.
 */
export const RESERVED_CARD_KEYS = new Set(["title", "status", "order", "due", "date", "assignee"]);

/** What a board shows as chips when its README doesn't say: tags, as before. */
export const DEFAULT_CARD_FIELDS: FieldSpec[] = [{ name: "tags", colors: {} }];

export interface BoardCard {
  path: string;
  name: string;
  /** Front-matter `title`, when set — cards prefer it over the file name. */
  title?: string;
  /** The raw `status` as written (trimmed), or null when the card has none. */
  status: string | null;
  /** Place within its column; null when never arranged. */
  order: number | null;
  /**
   * Every other front-matter key whose value is text, a number, or a list of
   * them, as strings. The board shows the ones its README picks as chips.
   */
  fields: Record<string, string[]>;
  /** `due`, else `date`, as `YYYY-MM-DD`. */
  due: string | null;
  assignees: string[];
  /** Task-list progress from the body's `- [ ]` / `- [x]` lines. */
  checklist: { done: number; total: number } | null;
  /** A server-kept conflicted copy — shown with a badge so it isn't mistaken for a duplicate. */
  conflicted: boolean;
}

export interface BoardColumn {
  /** Case-folded status value this column holds. */
  key: string;
  /** The spelling shown, and written into a card moved here. */
  label: string;
  /** False for a value cards carry that the README's `columns` doesn't list. */
  declared: boolean;
  color: BoardColor | null;
  cards: BoardCard[];
}

export interface BoardLayout {
  columns: BoardColumn[];
  /** Cards with no `status`, for the collapsible "No status" lane. */
  unsorted: BoardCard[];
}

/** Case-folded key used to match a `status` value to a column. */
export function columnKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A usable `status` value: a non-empty string, or a number (YAML reads
 * `status: 1` as one). Anything else — a list, a map, a boolean — counts as no
 * status rather than being guessed at.
 */
export function cardStatus(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** A front-matter value read as a list of strings: a scalar becomes one item. */
export function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
    else if (typeof item === "number" && Number.isFinite(item)) out.push(String(item));
  }
  return out;
}

const FENCE_RE = /^\s*(```|~~~)/;
const TASK_RE = /^\s*[-*+]\s+\[([ xX])\]\s/;

/** Count task-list items in a markdown body, ignoring fenced code. Null when there are none. */
export function checklistCounts(body: string): { done: number; total: number } | null {
  let inFence = false;
  let done = 0;
  let total = 0;
  for (const line of body.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = TASK_RE.exec(line);
    if (!match) continue;
    total++;
    if (match[1] !== " ") done++;
  }
  return total ? { done, total } : null;
}

/** Build a card from a markdown child's parsed front matter and body. */
export function toBoardCard(
  file: { path: string; name: string; conflicted?: boolean },
  fm: FrontMatterData | null,
  body: string,
): BoardCard {
  const title = typeof fm?.title === "string" && fm.title.trim() ? fm.title : undefined;
  const order = typeof fm?.order === "number" && Number.isFinite(fm.order) ? fm.order : null;
  const fields: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(fm ?? {})) {
    if (RESERVED_CARD_KEYS.has(key)) continue;
    const values = stringList(value);
    if (values.length) fields[key] = values;
  }
  return {
    path: file.path,
    name: file.name,
    title,
    status: cardStatus(fm?.status),
    order,
    fields,
    due: toDateKey(fm?.due) ?? toDateKey(fm?.date),
    assignees: stringList(fm?.assignee),
    checklist: checklistCounts(body),
    conflicted: file.conflicted ?? false,
  };
}

/** A card's display label: its title, else its file name without the extension. */
export function cardLabel(card: { title?: string; name: string }): string {
  return card.title ?? withoutMarkdownExtension(card.name);
}

/** The name of a `columns`/`card_fields` entry: a plain scalar, or a map's `name`. */
function entryName(entry: unknown): string | null {
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    return stringList((entry as Record<string, unknown>).name)[0] ?? null;
  }
  return stringList(entry)[0] ?? null;
}

/**
 * The README's declared `columns`, trimmed and de-duplicated case-insensitively
 * (first spelling wins). Each entry is a name, or `{ name, color }`. Null when
 * absent or not a list, so callers can tell "no declaration" from "declared
 * empty".
 */
export function declaredColumns(fm: FrontMatterData | null): ColumnSpec[] | null {
  if (!fm || !Array.isArray(fm.columns)) return null;
  const seen = new Set<string>();
  const out: ColumnSpec[] = [];
  for (const entry of fm.columns) {
    const name = entryName(entry);
    if (name === null) continue;
    const key = columnKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const color =
      entry !== null && typeof entry === "object"
        ? boardColor((entry as Record<string, unknown>).color)
        : null;
    out.push({ name, color });
  }
  return out;
}

/** Columns back into front matter: a plain name unless it carries a colour. */
export function serializeColumns(columns: ColumnSpec[]): unknown[] {
  return columns.map((c) => (c.color ? { name: c.name, color: c.color } : c.name));
}

/**
 * The README's `card_fields`: which keys show as chips, in order, each a name
 * or `{ name, colors: { value: colour } }`. Without a declaration a board shows
 * `tags`, as it always has; a declared empty list shows none.
 */
export function cardFields(fm: FrontMatterData | null): FieldSpec[] {
  if (!fm || !Array.isArray(fm.card_fields)) return DEFAULT_CARD_FIELDS;
  const seen = new Set<string>();
  const out: FieldSpec[] = [];
  for (const entry of fm.card_fields) {
    const name = entryName(entry);
    if (name === null || seen.has(name) || RESERVED_CARD_KEYS.has(name)) continue;
    seen.add(name);
    const colors: Record<string, BoardColor> = {};
    const raw =
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>).colors
        : undefined;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [value, color] of Object.entries(raw as Record<string, unknown>)) {
        const c = boardColor(color);
        if (c) colors[value] = c;
      }
    }
    const hidden =
      entry !== null &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).hidden === true;
    out.push(hidden ? { name, colors, hidden } : { name, colors });
  }
  return out;
}

/** The fields actually shown on cards (declared and not hidden). */
export function shownFields(fields: FieldSpec[]): FieldSpec[] {
  return fields.filter((f) => !f.hidden);
}

/** Card fields back into front matter: a plain name unless it carries colours or is hidden. */
export function serializeCardFields(fields: FieldSpec[]): unknown[] {
  return fields.map((f) => {
    if (!Object.keys(f.colors).length && !f.hidden) return f.name;
    const entry: Record<string, unknown> = { name: f.name };
    if (Object.keys(f.colors).length) entry.colors = { ...f.colors };
    if (f.hidden) entry.hidden = true;
    return entry;
  });
}

/** The colour set for one of a field's values, matched ignoring case. */
export function fieldColor(field: FieldSpec, value: string): BoardColor | null {
  const want = value.trim().toLowerCase();
  for (const [v, c] of Object.entries(field.colors)) {
    if (v.trim().toLowerCase() === want) return c;
  }
  return null;
}

/**
 * `fields` with `value`'s colour in `name` set to `color` (null clears it). The
 * value keeps the spelling already written, so recolouring never duplicates it.
 */
export function withFieldColor(
  fields: FieldSpec[],
  name: string,
  value: string,
  color: BoardColor | null,
): FieldSpec[] {
  return fields.map((f) => {
    if (f.name !== name) return f;
    const colors: Record<string, BoardColor> = {};
    const want = value.trim().toLowerCase();
    let placed = false;
    for (const [v, c] of Object.entries(f.colors)) {
      if (v.trim().toLowerCase() === want) {
        placed = true;
        if (color) colors[v] = color;
      } else colors[v] = c;
    }
    if (!placed && color) colors[value] = color;
    return f.hidden ? { name: f.name, colors, hidden: true } : { name: f.name, colors };
  });
}

/**
 * `fields` with `name` shown (appended, or un-hidden) or hidden. A field with
 * colours is hidden rather than dropped, so turning it back on brings them back.
 */
export function withFieldShown(fields: FieldSpec[], name: string, shown: boolean): FieldSpec[] {
  const existing = fields.find((f) => f.name === name);
  if (shown) {
    if (!existing) return [...fields, { name, colors: {} }];
    return fields.map((f) => (f.name === name ? { name: f.name, colors: f.colors } : f));
  }
  if (!existing) return fields;
  if (!Object.keys(existing.colors).length) return fields.filter((f) => f.name !== name);
  return fields.map((f) => (f.name === name ? { ...f, hidden: true } : f));
}

/**
 * The keys a board could show as chips: every non-reserved key any card has,
 * plus any already chosen, with how many cards carry each and their distinct
 * values (first spelling wins), for the Fields panel.
 */
export function availableFields(
  cards: BoardCard[],
  chosen: FieldSpec[],
): { name: string; count: number; values: string[] }[] {
  const byName = new Map<string, { count: number; values: Map<string, string> }>();
  const ensure = (name: string) => {
    let entry = byName.get(name);
    if (!entry) byName.set(name, (entry = { count: 0, values: new Map() }));
    return entry;
  };
  for (const f of chosen) ensure(f.name);
  for (const card of cards) {
    for (const [name, values] of Object.entries(card.fields)) {
      const entry = ensure(name);
      entry.count++;
      for (const v of values)
        if (!entry.values.has(v.toLowerCase())) entry.values.set(v.toLowerCase(), v);
    }
  }
  return [...byName.entries()]
    .map(([name, e]) => ({
      name,
      count: e.count,
      values: [...e.values.values()].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Arranged cards first by `order`, then everything else by label. */
export function compareCards(a: BoardCard, b: BoardCard): number {
  if (a.order !== null && b.order !== null && a.order !== b.order) return a.order - b.order;
  if (a.order !== null && b.order === null) return -1;
  if (a.order === null && b.order !== null) return 1;
  return cardLabel(a).localeCompare(cardLabel(b), undefined, { sensitivity: "base" });
}

/**
 * Arrange cards into columns. Declared columns come first in their listed
 * order, including empty ones. A status the declaration doesn't list gets its
 * own column after them (never hidden), labelled by the first spelling seen.
 * Without a declaration every column is derived, in order of first appearance
 * across the title-sorted cards so the result doesn't depend on read order.
 */
export function buildBoard(cards: BoardCard[], declared: ColumnSpec[] | null): BoardLayout {
  const sorted = [...cards].sort(compareCards);
  const columns: BoardColumn[] = [];
  const byKey = new Map<string, BoardColumn>();
  for (const spec of declared ?? []) {
    const column: BoardColumn = {
      key: columnKey(spec.name),
      label: spec.name,
      declared: true,
      color: spec.color,
      cards: [],
    };
    columns.push(column);
    byKey.set(column.key, column);
  }
  const unsorted: BoardCard[] = [];
  const firstSeen = [...cards].sort((a, b) => cardLabel(a).localeCompare(cardLabel(b)));
  for (const card of firstSeen) {
    if (card.status === null) continue;
    const key = columnKey(card.status);
    if (byKey.has(key)) continue;
    const column: BoardColumn = {
      key,
      label: card.status,
      declared: declared === null,
      color: null,
      cards: [],
    };
    columns.push(column);
    byKey.set(key, column);
  }
  for (const card of sorted) {
    if (card.status === null) unsorted.push(card);
    else byKey.get(columnKey(card.status))!.cards.push(card);
  }
  return { columns, unsorted };
}

/**
 * Where a drop at `index` can actually land. Arranged cards form a prefix of
 * the column (see `compareCards`), and a card can be placed anywhere within
 * that run with ONE write — its own `order`. Placing it among the unarranged
 * cards after the run would mean writing their orders too, so a drop there
 * lands at the end of the run instead. The board draws its insertion line at
 * this index, so what you see is where the card goes.
 *
 * `cards` is the target column in display order WITHOUT the dragged card.
 */
export function effectiveDropIndex(cards: BoardCard[], index: number): number {
  const arranged = cards.findIndex((c) => c.order === null);
  const runLength = arranged === -1 ? cards.length : arranged;
  return Math.max(0, Math.min(index, runLength));
}

/** The `order` to write for a card dropped at `index` (see `effectiveDropIndex`). */
export function orderForDrop(cards: BoardCard[], index: number): number {
  const at = effectiveDropIndex(cards, index);
  const prev = cards[at - 1]?.order ?? null;
  const next = cards[at]?.order ?? null;
  if (prev === null && next === null) return 1;
  if (prev === null) return next! - 1;
  if (next === null) return prev + 1;
  return (prev + next) / 2;
}

export type MoveBlock = "read-only" | "no-drag" | "unknown-card" | "no-change" | "in-flight";

/**
 * Whether a drop should write, mirroring the calendar's `decideReschedule`: a
 * read-only board never writes, and a second drop on a card whose last move is
 * still settling is ignored so two fast drags can't race each other's version.
 */
export function decideMove(input: {
  canMove: boolean;
  dragPath: string | null;
  card: BoardCard | undefined;
  toStatus: string | null;
  toOrder: number | null;
  inFlight: boolean;
}): { proceed: true; path: string } | { proceed: false; reason: MoveBlock } {
  if (!input.canMove) return { proceed: false, reason: "read-only" };
  if (!input.dragPath) return { proceed: false, reason: "no-drag" };
  if (!input.card) return { proceed: false, reason: "unknown-card" };
  const sameColumn =
    (input.card.status === null && input.toStatus === null) ||
    (input.card.status !== null &&
      input.toStatus !== null &&
      columnKey(input.card.status) === columnKey(input.toStatus));
  if (sameColumn && (input.toOrder === null || input.toOrder === input.card.order)) {
    return { proceed: false, reason: "no-change" };
  }
  if (input.inFlight) return { proceed: false, reason: "in-flight" };
  return { proceed: true, path: input.dragPath };
}

export interface MemberLike {
  id: string;
  name: string;
  image: string | null;
}

/**
 * The workspace member an `assignee` value names, or null. Matches a user id,
 * the full display name, or — when exactly one member has it — a first name,
 * all case-insensitively. Anything else (an agent, a client, someone not yet
 * invited) is a legitimate free-text assignee and renders as plain initials.
 */
export function resolveAssignee<M extends MemberLike>(value: string, members: M[]): M | null {
  const want = value.trim().toLowerCase();
  if (!want) return null;
  const byId = members.find((m) => m.id === value.trim());
  if (byId) return byId;
  const byName = members.find((m) => m.name.trim().toLowerCase() === want);
  if (byName) return byName;
  const byFirst = members.filter((m) => m.name.trim().split(/\s+/)[0]?.toLowerCase() === want);
  return byFirst.length === 1 ? byFirst[0]! : null;
}

/** Up to two initials for a free-text assignee chip. */
export function assigneeInitials(value: string): string {
  const words = value
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * Whether assignee value `a` names the same person as `name`: the same text, or
 * both resolving to the same member (so `Zef` and `Zef Maxted` are one person).
 */
export function sameAssignee(a: string, name: string, members: MemberLike[] = []): boolean {
  if (a.trim().toLowerCase() === name.trim().toLowerCase()) return true;
  const target = resolveAssignee(name, members);
  return target !== null && resolveAssignee(a, members)?.id === target.id;
}

/**
 * The `assignee` value to write after toggling `name`: a plain string for one
 * person, a list for several, undefined (remove the key) for nobody.
 */
export function toggledAssignee(
  current: string[],
  name: string,
  members: MemberLike[] = [],
): string | string[] | undefined {
  const has = current.some((a) => sameAssignee(a, name, members));
  const next = has ? current.filter((a) => !sameAssignee(a, name, members)) : [...current, name];
  if (next.length === 0) return undefined;
  return next.length === 1 ? next[0] : next;
}

/**
 * A file name for a new card titled `title` that doesn't collide with
 * `existingNames` (compared case-insensitively, since the sync targets include
 * case-insensitive filesystems).
 */
export function cardFileName(title: string, existingNames: Iterable<string>): string {
  const taken = new Set([...existingNames].map((n) => n.toLowerCase()));
  const base = slugify(title) || "card";
  let name = `${base}.md`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}.md`;
  return name;
}

/**
 * The front-matter patch that turns a folder's default page into a board
 * declaration. `columns` is only written when the page doesn't already have
 * one: seeded from the statuses cards already carry, else the defaults.
 */
export function boardDeclarationPatch(
  fm: FrontMatterData | null,
  existingStatuses: string[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = { view: "board" };
  if (declaredColumns(fm) === null) {
    patch.columns = existingStatuses.length ? existingStatuses : [...DEFAULT_COLUMNS];
  }
  return patch;
}

/**
 * The README a brand-new board folder starts with. `fields` adds to (or
 * replaces) the declared columns, e.g. a folder being turned into a board keeps
 * the statuses its cards already use.
 */
export async function newBoardReadme(
  title: string,
  fields: Record<string, unknown> = { columns: [...DEFAULT_COLUMNS] },
): Promise<string> {
  const { serializeFrontMatter } = await loadFrontMatterData();
  const block = serializeFrontMatter({ title, view: "board", ...fields });
  return `${block}
Each markdown file in this folder is a card on the board. A card's \`status\` in its front matter sets its column.
`;
}

/** Distinct statuses across `cards`, first spelling wins, in board column order. */
export function distinctStatuses(cards: BoardCard[]): string[] {
  return buildBoard(cards, null).columns.map((c) => c.label);
}