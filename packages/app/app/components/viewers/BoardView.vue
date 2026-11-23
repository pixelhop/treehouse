<script setup lang="ts">
import IconAdd from "~icons/solar/add-circle-linear";
import IconMore from "~icons/solar/menu-dots-bold";
import IconLeft from "~icons/solar/alt-arrow-left-linear";
import IconRight from "~icons/solar/alt-arrow-right-linear";
import IconFields from "~icons/solar/tuning-2-linear";
import type { BoardActions } from "~/composables/useBoardActions";
import type { FrontMatterWriteResult } from "~/composables/useFrontMatterWrite";
// Aliased: `BoardCard` in the template is the card component.
import {
  availableFields,
  type BoardCard as Card,
  type BoardColor,
  type BoardColumn,
  buildBoard,
  cardLabel,
  chipStyle,
  columnKey,
  columnStyle,
  type ColumnSpec,
  DEFAULT_CARD_FIELDS,
  decideMove,
  dotStyle,
  effectiveDropIndex,
  fieldColor,
  type FieldSpec,
  type MemberLike,
  orderForDrop,
  shownFields,
  withFieldColor,
  withFieldShown,
} from "~/utils/board";

// A folder shown as a board: one column per `status`, one card per markdown
// file. Writing is an INJECTED CAPABILITY, exactly as on the calendar (see
// CalendarView): the workspace passes `actions`, a public share doesn't, so a
// shared board has no write path at all rather than a flag guarding one.
// `decideMove` re-checks it anyway.
const props = defineProps<{
  name: string;
  cards: Card[];
  /** The README's declared `columns` (names and colours), or null when it declares none. */
  columns: ColumnSpec[] | null;
  /** The README's `card_fields`: which keys show as chips on cards, and their colours. */
  fields?: FieldSpec[];
  loading?: boolean;
  members?: MemberLike[];
  actions?: BoardActions;
}>();
const emit = defineEmits<{ open: [path: string] }>();

const editable = computed(() => !!props.actions);
const members = computed(() => props.members ?? props.actions?.members ?? []);

// A phone gets one column at a time, picked from tabs. Wider screens scroll the
// columns sideways, as a board should.
const phone = useMediaQuery("(max-width: 639.98px)");
const canDrag = computed(() => editable.value && !phone.value);

// --- Optimistic moves (the calendar's pattern) -----------------------------
// Overrides layered over props so a moved card jumps immediately. Cleared when
// the refetched props catch up (success) or when the write fails (snap back).
type Placement = { status: string | null; order?: number | null };
const overrides = reactive(new Map<string, Placement>());
// A second move of a card is ignored until its first settles, so two fast drags
// can't both read the same base version and race each other.
const pending = reactive(new Set<string>());

const displayCards = computed(() =>
  props.cards.map((c) => {
    const o = overrides.get(c.path);
    if (!o) return c;
    return { ...c, status: o.status, ...(o.order !== undefined ? { order: o.order } : {}) };
  }),
);

const sameStatus = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : columnKey(a) === columnKey(b);

watch(
  () => props.cards,
  (cards) => {
    for (const [path, o] of overrides) {
      const current = cards.find((c) => c.path === path);
      // Clear only once the refetched prop carries the move. Not on absence: a
      // card is transiently missing while its version-bumped read is in flight.
      if (
        current &&
        sameStatus(current.status, o.status) &&
        (o.order === undefined || current.order === o.order)
      ) {
        overrides.delete(path);
      }
    }
  },
);

// README settings (columns and card fields) apply optimistically too: the write
// lands in the README, and waiting for its re-read would make every colour
// click and field toggle lag. Each override clears once the README's new
// front matter arrives, or when the write fails.
const pendingColumns = ref<ColumnSpec[] | null>(null);
const pendingFields = ref<FieldSpec[] | null>(null);
watch(
  () => props.columns,
  () => (pendingColumns.value = null),
);
watch(
  () => props.fields,
  () => (pendingFields.value = null),
);
const columnsNow = computed(() => pendingColumns.value ?? props.columns);
const fieldsNow = computed(() => pendingFields.value ?? props.fields ?? DEFAULT_CARD_FIELDS);

const layout = computed(() => buildBoard(displayCards.value, columnsNow.value));
/** The column list a column edit writes back: the declaration, else what's derived. */
const currentColumns = computed<ColumnSpec[]>(
  () => columnsNow.value ?? layout.value.columns.map((c) => ({ name: c.label, color: c.color })),
);
const moveTargets = computed(() =>
  layout.value.columns.map((c) => ({ name: c.label, color: c.color })),
);

// --- Notices ---------------------------------------------------------------
const notice = ref<string | null>(null);

function reportWrite(res: FrontMatterWriteResult, label: string, verb: string) {
  if (res.status === "ok") return;
  notice.value =
    res.status === "conflict"
      ? `“${label}” changed on the server, so your ${verb} was kept as a copy${
          res.conflictCopyPath ? `: ${res.conflictCopyPath}` : ""
        }.`
      : `Couldn't ${verb} “${label}”. It may have changed. Refresh and try again.`;
}

async function place(card: Card, to: Placement) {
  if (!props.actions) return;
  pending.add(card.path);
  overrides.set(card.path, to);
  try {
    const res = await props.actions.move(card.path, to);
    if (res.status !== "ok") overrides.delete(card.path); // snap back
    reportWrite(res, cardLabel(card), "move");
  } finally {
    pending.delete(card.path);
  }
}

// --- Drag and drop -----------------------------------------------------------
// Native HTML5 drag, like the calendar. A custom type so the workspace's file
// upload drop zone never mistakes a card for a file being dropped in.
const CARD_MIME = "application/x-treehouse-card";
const dragPath = ref<string | null>(null);
/** Where the card would land: a column key (null = No status) and an index. */
const drop = ref<{ key: string | null; index: number } | null>(null);

function onDragStart(card: Card, e: DragEvent) {
  if (!canDrag.value) return;
  menuColumn.value = null;
  dragPath.value = card.path;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(CARD_MIME, card.path);
  }
}

function onDragEnd() {
  dragPath.value = null;
  drop.value = null;
}

/** Cards of a column in display order, minus `path` (the card being dragged). */
const withoutCard = (column: BoardColumn, path: string | null) =>
  column.cards.filter((c) => c.path !== path);
const withoutDragged = (column: BoardColumn) => withoutCard(column, dragPath.value);

function onColumnDragOver(column: BoardColumn, e: DragEvent) {
  if (!canDrag.value || !dragPath.value) return;
  e.preventDefault(); // marks the column as a drop target
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  // Insertion index from the pointer against the other cards' midpoints.
  const list = e.currentTarget as HTMLElement; // the whole column, header included
  const others = [...list.querySelectorAll<HTMLElement>("[data-card-path]")].filter(
    (el) => el.dataset.cardPath !== dragPath.value,
  );
  let index = others.length;
  for (let i = 0; i < others.length; i++) {
    const r = others[i]!.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) {
      index = i;
      break;
    }
  }
  drop.value = { key: column.key, index };
}

function onUnsortedDragOver(e: DragEvent) {
  if (!canDrag.value || !dragPath.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  drop.value = { key: null, index: 0 };
}

/**
 * The card the insertion line sits above in `column`, or "end". Uses the same
 * snapping as the write (`effectiveDropIndex`), so the line shows where the card
 * will really land.
 */
function lineBefore(column: BoardColumn): string | "end" | null {
  if (!drop.value || drop.value.key !== column.key) return null;
  const others = withoutDragged(column);
  const at = effectiveDropIndex(others, drop.value.index);
  return others[at]?.path ?? "end";
}

function onDrop(column: BoardColumn | null) {
  const path = dragPath.value;
  const target = drop.value;
  onDragEnd();
  const card = displayCards.value.find((c) => c.path === path);
  const toStatus = column?.label ?? null;
  // Into a column the card is placed exactly; into No status only its status
  // changes. Neighbours are worked out without the dropped card, by its saved
  // path: the drag state is already cleared, so `withoutDragged` would leave the
  // card in its own column and a same-column reorder would land one slot off.
  const toOrder = column && target ? orderForDrop(withoutCard(column, path), target.index) : null;
  const decision = decideMove({
    canMove: editable.value,
    dragPath: path,
    card,
    toStatus,
    toOrder,
    inFlight: !!path && pending.has(path),
  });
  if (!decision.proceed || !card) return;
  void place(card, column ? { status: toStatus, order: toOrder } : { status: null });
}

// Move to… from a card's menu: straight to the column's unarranged tail.
function moveFromMenu(card: Card, status: string | null) {
  if (pending.has(card.path)) return;
  void place(card, { status, order: null });
}

async function toggleAssignee(card: Card, name: string) {
  if (!props.actions) return;
  reportWrite(await props.actions.toggleAssignee(card, name), cardLabel(card), "assign");
}

// --- The No status lane ------------------------------------------------------
const unsortedOpen = ref(false);

// --- Adding cards --------------------------------------------------------------
/** The column whose add-card input is open (null = No status), or undefined. */
const addingIn = ref<string | null | undefined>(undefined);
const newTitle = ref("");
const creating = ref(false);

async function openAdd(key: string | null) {
  addingIn.value = key;
  newTitle.value = "";
  await nextTick();
  document.getElementById("board-new-card")?.focus();
}

async function submitCard(column: BoardColumn | null) {
  const title = newTitle.value.trim();
  if (!title || !props.actions || creating.value) return;
  creating.value = true;
  try {
    const res = await props.actions.createCard(title, column?.label ?? null);
    if (res.status === "ok") newTitle.value = ""; // stay open for the next one
    else notice.value = `Couldn't add “${title}”. Refresh and try again.`;
  } finally {
    creating.value = false;
  }
  await nextTick();
  document.getElementById("board-new-card")?.focus();
}

// --- Columns ---------------------------------------------------------------------
const addingColumn = ref(false);
const newColumn = ref("");
const menuColumn = ref<string | null>(null);

const COLUMNS_ERROR =
  "Couldn't update the board's columns. Its README may have changed, or it isn't a markdown file. Refresh and try again.";

async function writeColumns(columns: ColumnSpec[]) {
  if (!props.actions) return;
  pendingColumns.value = columns;
  const res = await props.actions.setColumns(columns);
  if (res.status !== "ok") {
    pendingColumns.value = null;
    notice.value = COLUMNS_ERROR;
  }
}

function setColumnColor(column: BoardColumn, color: BoardColor | null) {
  void writeColumns(
    currentColumns.value.map((c) => (columnKey(c.name) === column.key ? { ...c, color } : c)),
  );
}

async function openAddColumn() {
  addingColumn.value = true;
  newColumn.value = "";
  await nextTick();
  document.getElementById("board-new-column")?.focus();
}

async function submitColumn() {
  const label = newColumn.value.trim();
  addingColumn.value = false;
  if (!label) return;
  const existing = layout.value.columns.find((c) => c.key === columnKey(label));
  // Naming an undeclared column declares it; naming a declared one is a no-op.
  if (existing?.declared) return;
  await writeColumns([...currentColumns.value, { name: existing?.label ?? label, color: null }]);
}

function addToColumns(column: BoardColumn) {
  void writeColumns([...(columnsNow.value ?? []), { name: column.label, color: null }]);
}

async function renameColumn(column: BoardColumn) {
  menuColumn.value = null;
  if (!props.actions) return;
  const to = window.prompt("Rename column", column.label)?.trim();
  if (!to || to === column.label) return;
  const clash = layout.value.columns.find((c) => c !== column && c.key === columnKey(to));
  if (clash) return void window.alert(`There's already a column called “${clash.label}”.`);
  const n = column.cards.length;
  if (
    n > 0 &&
    !window.confirm(
      `Rename “${column.label}” to “${to}”? This also updates the status of ${n} ${
        n === 1 ? "card" : "cards"
      }.`,
    )
  ) {
    return;
  }
  const { readme, failed } = await props.actions.renameColumn(
    currentColumns.value,
    column.label,
    to,
    column.cards,
  );
  if (readme.status !== "ok") notice.value = COLUMNS_ERROR;
  else if (failed.length) {
    notice.value = `Renamed the column, but ${failed.length} ${
      failed.length === 1 ? "card" : "cards"
    } couldn't be updated. Refresh and move them with Move to….`;
  }
}

function removeColumn(column: BoardColumn) {
  menuColumn.value = null;
  if (column.cards.length) return;
  void writeColumns(currentColumns.value.filter((c) => columnKey(c.name) !== column.key));
}

// --- Card fields (the Fields panel) ----------------------------------------------
// Which other front-matter keys show as chips on cards, and a colour for each
// of their values: Notion's "properties", written into the README's
// `card_fields` so an agent can read and set them too.
const fieldsOpen = ref(false);
const fieldOptions = computed(() => availableFields(props.cards, fieldsNow.value));
const isShown = (name: string) => fieldsNow.value.some((f) => f.name === name && !f.hidden);
const cardChipFields = computed(() => shownFields(fieldsNow.value));
/** How many values the panel lists per field before summarising the rest. */
const MAX_FIELD_VALUES = 12;

async function writeFields(fields: FieldSpec[]) {
  if (!props.actions) return;
  pendingFields.value = fields;
  const res = await props.actions.setCardFields(fields);
  if (res.status !== "ok") {
    pendingFields.value = null;
    notice.value =
      "Couldn't update which fields show on cards. The board's README may have changed. Refresh and try again.";
  }
}

function toggleField(name: string) {
  void writeFields(withFieldShown(fieldsNow.value, name, !isShown(name)));
}

function setValueColor(name: string, value: string, color: BoardColor | null) {
  void writeFields(withFieldColor(fieldsNow.value, name, value, color));
}

/** The value whose palette is open in the Fields panel, as `valueKey`. */
const editingValue = ref<string | null>(null);
const valueKey = (name: string, value: string) => `${name}\u0000${value.toLowerCase()}`;

function valueColor(name: string, value: string): BoardColor | null {
  const field = fieldsNow.value.find((f) => f.name === name);
  return field ? fieldColor(field, value) : null;
}

// --- Phone: one column at a time --------------------------------------------------
const UNSORTED_TAB = "\u0000unsorted";
const activeTab = ref<string | null>(null);
const tabs = computed(() => {
  const out: { key: string; label: string; count: number; color: BoardColor | null }[] =
    layout.value.columns.map((c) => ({
      key: c.key,
      label: c.label,
      count: c.cards.length,
      color: c.color,
    }));
  if (layout.value.unsorted.length) {
    out.push({
      key: UNSORTED_TAB,
      label: "No status",
      count: layout.value.unsorted.length,
      color: null,
    });
  }
  return out;
});
const currentTab = computed(() =>
  tabs.value.some((t) => t.key === activeTab.value)
    ? activeTab.value
    : (tabs.value[0]?.key ?? null),
);
const tabIndex = computed(() => tabs.value.findIndex((t) => t.key === currentTab.value));
function stepTab(delta: number) {
  const next = tabs.value[tabIndex.value + delta];
  if (next) activeTab.value = next.key;
}
const visibleColumns = computed(() =>
  phone.value
    ? layout.value.columns.filter((c) => c.key === currentTab.value)
    : layout.value.columns,
);
const showUnsorted = computed(
  () => layout.value.unsorted.length > 0 && (!phone.value || currentTab.value === UNSORTED_TAB),
);

const isEmpty = computed(
  () => layout.value.columns.length === 0 && layout.value.unsorted.length === 0,
);

const inputClass =
  "w-full rounded-md border border-border bg-surface px-2.5 py-2 text-base text-fg outline-none transition focus:border-accent lg:py-1.5 lg:text-sm";
const menuItemClass =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-fg-subtle disabled:hover:bg-transparent lg:py-1.5";
</script>

<template>
  <div class="flex h-full flex-col gap-4">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="min-w-0 truncate text-lg font-semibold text-fg">
        <!-- ph-mask: a board heading may come from user-authored front matter or a folder name. -->
        <span v-if="name" class="ph-mask">{{ name }}</span>
        <span v-else>Board</span>
      </h2>
      <!-- Fields: which other front-matter keys show on cards, and value
           colours. Notion's "properties" panel, kept in the README. -->
      <div v-if="editable" class="relative">
        <button
          type="button"
          :aria-expanded="fieldsOpen"
          class="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm text-fg-muted transition hover:bg-surface-2 hover:text-fg lg:h-8"
          :class="fieldsOpen ? 'bg-surface-2 text-fg' : ''"
          @click="fieldsOpen = !fieldsOpen"
        >
          <IconFields class="h-4 w-4" /> Fields
        </button>
        <div
          v-if="fieldsOpen"
          class="absolute top-full right-0 z-30 mt-1 max-h-[70vh] w-80 overflow-y-auto rounded-lg border border-border bg-surface p-2 shadow-lg"
          @keydown.esc="fieldsOpen = false"
        >
          <p class="px-1.5 pt-1 pb-2 text-xs font-medium text-fg-subtle">Show on cards</p>
          <p v-if="!fieldOptions.length" class="px-1.5 pb-2 text-sm text-fg-muted">
            Cards have no other front matter yet. Add a key such as
            <code class="text-xs">project:</code> to a card and it appears here.
          </p>
          <div v-for="opt in fieldOptions" :key="opt.name" class="rounded-md">
            <label
              class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm text-fg transition hover:bg-surface-2"
            >
              <input
                type="checkbox"
                class="accent-[var(--th-accent)]"
                :checked="isShown(opt.name)"
                @change="toggleField(opt.name)"
              />
              <!-- ph-mask: field names are user-authored front-matter keys. -->
              <span class="ph-mask min-w-0 flex-1 truncate font-medium">{{ opt.name }}</span>
              <span class="shrink-0 text-xs text-fg-subtle">
                {{ opt.count }} {{ opt.count === 1 ? "card" : "cards" }}
              </span>
            </label>
            <!-- Colours for the values of a shown field: one compact row each,
                 with the palette opening only for the value being coloured. -->
            <ul
              v-if="isShown(opt.name) && opt.values.length"
              class="mb-1.5 ml-7 space-y-0.5 py-0.5"
            >
              <li v-for="value in opt.values.slice(0, MAX_FIELD_VALUES)" :key="value">
                <div class="flex items-center gap-2 py-0.5">
                  <!-- ph-mask: values are user-authored front matter. -->
                  <span
                    class="ph-mask min-w-0 truncate rounded-full px-2 py-0.5 text-xs"
                    :class="
                      valueColor(opt.name, value) ? 'font-medium' : 'bg-surface-2 text-fg-muted'
                    "
                    :style="
                      valueColor(opt.name, value)
                        ? chipStyle(valueColor(opt.name, value)!)
                        : undefined
                    "
                    >{{ value }}</span
                  >
                  <button
                    type="button"
                    :aria-label="`Colour for ${value}`"
                    :aria-expanded="editingValue === valueKey(opt.name, value)"
                    class="ml-auto h-4 w-4 shrink-0 rounded-full transition hover:scale-110"
                    :class="
                      valueColor(opt.name, value) ? '' : 'border border-dashed border-fg-subtle'
                    "
                    :style="
                      valueColor(opt.name, value)
                        ? dotStyle(valueColor(opt.name, value)!)
                        : undefined
                    "
                    @click="
                      editingValue =
                        editingValue === valueKey(opt.name, value)
                          ? null
                          : valueKey(opt.name, value)
                    "
                  />
                </div>
                <ColorSwatches
                  v-if="editingValue === valueKey(opt.name, value)"
                  class="pt-1 pb-1.5"
                  :model-value="valueColor(opt.name, value)"
                  :label="`Colour for ${value}`"
                  @update:model-value="
                    setValueColor(opt.name, value, $event);
                    editingValue = null;
                  "
                />
              </li>
              <li v-if="opt.values.length > MAX_FIELD_VALUES" class="text-xs text-fg-subtle">
                and {{ opt.values.length - MAX_FIELD_VALUES }} more. Colour them in the README's
                <code>card_fields</code>.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </header>

    <div
      v-if="notice"
      class="flex items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg"
    >
      <!-- ph-mask: notices quote user-authored card names and paths. -->
      <span class="ph-mask min-w-0 flex-1">{{ notice }}</span>
      <button type="button" class="shrink-0 text-fg-muted hover:text-fg" @click="notice = null">
        Dismiss
      </button>
    </div>

    <p v-if="loading && !cards.length && isEmpty" class="text-sm text-fg-subtle">Loading board…</p>

    <!-- A declared board with nothing on it yet: say so, and offer the first step. -->
    <div
      v-else-if="isEmpty"
      class="rounded-xl border border-dashed border-border px-6 py-10 text-center"
    >
      <p class="text-sm text-fg-muted">
        {{ editable ? "This board has no columns yet." : "This board has no cards yet." }}
      </p>
      <button
        v-if="editable && !addingColumn"
        type="button"
        class="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:opacity-90"
        @click="openAddColumn"
      >
        <IconAdd class="h-4 w-4" /> Add column
      </button>
      <form v-else-if="addingColumn" class="mx-auto mt-3 max-w-xs" @submit.prevent="submitColumn">
        <input
          id="board-new-column"
          v-model="newColumn"
          :class="inputClass"
          placeholder="Column name"
          @keydown.esc="addingColumn = false"
          @blur="submitColumn"
        />
      </form>
    </div>

    <template v-else>
      <!-- Phone: pick a column, see its cards full width. -->
      <div v-if="phone" class="flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous column"
          class="grid h-9 w-9 shrink-0 place-items-center rounded-md text-fg-muted transition hover:bg-surface-2 disabled:opacity-40"
          :disabled="tabIndex <= 0"
          @click="stepTab(-1)"
        >
          <IconLeft class="h-4 w-4" />
        </button>
        <div role="tablist" aria-label="Columns" class="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            type="button"
            role="tab"
            :aria-selected="tab.key === currentTab"
            class="shrink-0 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition"
            :class="
              tab.key === currentTab
                ? 'bg-accent font-medium text-accent-fg'
                : 'bg-surface-2 text-fg-muted'
            "
            @click="activeTab = tab.key"
          >
            <!-- ph-mask: column names are user-authored front matter. -->
            <span
              v-if="tab.color"
              aria-hidden="true"
              class="mr-1 inline-block h-2 w-2 rounded-full align-middle"
              :style="dotStyle(tab.color)"
            />
            <span class="ph-mask">{{ tab.label }}</span> · {{ tab.count }}
          </button>
        </div>
        <button
          type="button"
          aria-label="Next column"
          class="grid h-9 w-9 shrink-0 place-items-center rounded-md text-fg-muted transition hover:bg-surface-2 disabled:opacity-40"
          :disabled="tabIndex >= tabs.length - 1"
          @click="stepTab(1)"
        >
          <IconRight class="h-4 w-4" />
        </button>
      </div>

      <div
        class="flex min-h-0 flex-1 items-start gap-3 pb-6"
        :class="phone ? '' : '-mx-1 overflow-x-auto px-1'"
      >
        <!-- The No status lane: cards with no `status`. Collapsed to a strip by
             default so it doesn't crowd the real columns, and only there at all
             when it has cards. Dropping a card on it removes its status. -->
        <template v-if="showUnsorted">
          <button
            v-if="!unsortedOpen && !phone"
            type="button"
            class="flex w-10 shrink-0 flex-col items-center gap-2 self-stretch rounded-xl border border-dashed border-border py-3 text-xs font-semibold tracking-wide text-fg-subtle uppercase transition hover:border-accent/50 hover:text-fg"
            :class="drop && drop.key === null ? 'border-accent bg-accent/5' : ''"
            title="Show cards with no status"
            @dragover="onUnsortedDragOver"
            @dragleave="drop = null"
            @drop.prevent="onDrop(null)"
            @click="unsortedOpen = true"
          >
            <span class="[writing-mode:vertical-rl]">No status</span>
            <span class="rounded-full bg-surface-2 px-1.5 py-0.5 text-fg-muted">
              {{ layout.unsorted.length }}
            </span>
          </button>
          <section
            v-else
            class="flex shrink-0 flex-col rounded-xl border border-dashed border-border p-2"
            :class="[
              phone ? 'w-full' : 'w-64',
              drop && drop.key === null ? 'border-accent bg-accent/5' : '',
            ]"
            @dragover="onUnsortedDragOver"
            @drop.prevent="onDrop(null)"
          >
            <header class="flex items-center gap-2 px-1.5 pt-0.5 pb-2">
              <h3 class="text-xs font-semibold tracking-wide text-fg-subtle uppercase">
                No status
              </h3>
              <span class="text-xs text-fg-subtle">{{ layout.unsorted.length }}</span>
              <button
                v-if="!phone"
                type="button"
                class="ml-auto rounded-md px-1.5 py-0.5 text-xs text-fg-subtle transition hover:bg-surface-2 hover:text-fg"
                @click="unsortedOpen = false"
              >
                Collapse
              </button>
            </header>
            <ul class="space-y-2">
              <li v-for="card in layout.unsorted" :key="card.path" :data-card-path="card.path">
                <BoardCard
                  :card="card"
                  :members="members"
                  :columns="moveTargets"
                  :fields="cardChipFields"
                  :editable="editable"
                  :draggable="canDrag"
                  :dragging="dragPath === card.path"
                  @open="emit('open', card.path)"
                  @move="moveFromMenu(card, $event)"
                  @assign="toggleAssignee(card, $event)"
                  @dragstart="onDragStart(card, $event)"
                  @dragend="onDragEnd"
                />
              </li>
            </ul>
          </section>
        </template>

        <section
          v-for="column in visibleColumns"
          :key="column.key"
          class="flex shrink-0 flex-col rounded-xl p-2"
          :class="[
            phone ? 'w-full' : 'w-64',
            !column.declared
              ? 'border border-dashed border-warning/50 bg-surface-2/50'
              : column.color
                ? ''
                : 'bg-surface-2',
          ]"
          :style="column.declared && column.color ? columnStyle(column.color) : undefined"
          :aria-label="column.label"
          @dragover="onColumnDragOver(column, $event)"
          @drop.prevent="onDrop(column)"
        >
          <header class="relative flex items-center gap-2 px-1.5 pt-0.5 pb-2">
            <span
              v-if="column.color"
              aria-hidden="true"
              class="h-2.5 w-2.5 shrink-0 rounded-full"
              :style="dotStyle(column.color)"
            />
            <!-- ph-mask: column names are user-authored front matter. -->
            <h3
              class="ph-mask min-w-0 truncate text-xs font-semibold tracking-wide text-fg-muted uppercase"
            >
              {{ column.label }}
            </h3>
            <span class="text-xs text-fg-subtle">{{ column.cards.length }}</span>
            <button
              v-if="editable && column.declared"
              type="button"
              :aria-label="`Column actions for ${column.label}`"
              class="ml-auto grid h-7 w-7 place-items-center rounded-md text-fg-subtle transition hover:bg-surface hover:text-fg"
              @click="menuColumn = menuColumn === column.key ? null : column.key"
            >
              <IconMore class="h-4 w-4" />
            </button>
            <div
              v-if="menuColumn === column.key"
              class="absolute top-8 right-0 z-30 w-64 rounded-lg border border-border bg-surface p-1 shadow-lg"
            >
              <p class="px-2.5 pt-1.5 pb-1 text-xs font-medium text-fg-subtle">Colour</p>
              <ColorSwatches
                class="px-2.5 pb-2"
                :model-value="column.color"
                :label="`Colour for ${column.label}`"
                @update:model-value="setColumnColor(column, $event)"
              />
              <div class="my-1 border-t border-border" />
              <button type="button" :class="menuItemClass" @click="renameColumn(column)">
                Rename
              </button>
              <button
                type="button"
                :class="menuItemClass"
                :disabled="column.cards.length > 0"
                :title="column.cards.length ? 'Move its cards out first' : undefined"
                @click="removeColumn(column)"
              >
                Remove
              </button>
            </div>
          </header>

          <!-- A status the README's `columns` doesn't list (an agent wrote a new
               one, say): shown, never hidden, with a one-click fix. -->
          <div
            v-if="!column.declared"
            class="mb-2 flex items-center justify-between gap-2 px-1.5 text-xs text-fg-subtle"
          >
            <span>Not in this board's columns</span>
            <button
              v-if="editable"
              type="button"
              class="shrink-0 font-medium text-accent hover:underline"
              @click="addToColumns(column)"
            >
              Add to columns
            </button>
          </div>

          <ul class="min-h-10 space-y-2">
            <template v-for="card in column.cards" :key="card.path">
              <li
                v-if="lineBefore(column) === card.path"
                aria-hidden="true"
                class="h-0.5 rounded-full bg-accent"
              />
              <li :data-card-path="card.path">
                <BoardCard
                  :card="card"
                  :members="members"
                  :columns="moveTargets"
                  :fields="cardChipFields"
                  :editable="editable"
                  :draggable="canDrag"
                  :dragging="dragPath === card.path"
                  @open="emit('open', card.path)"
                  @move="moveFromMenu(card, $event)"
                  @assign="toggleAssignee(card, $event)"
                  @dragstart="onDragStart(card, $event)"
                  @dragend="onDragEnd"
                />
              </li>
            </template>
            <li
              v-if="lineBefore(column) === 'end'"
              aria-hidden="true"
              class="h-0.5 rounded-full bg-accent"
            />
          </ul>

          <template v-if="editable">
            <form v-if="addingIn === column.key" class="mt-2" @submit.prevent="submitCard(column)">
              <input
                id="board-new-card"
                v-model="newTitle"
                :class="inputClass"
                placeholder="Card title"
                :disabled="creating"
                @keydown.esc="addingIn = undefined"
              />
              <div class="mt-1.5 flex items-center gap-2">
                <button
                  type="submit"
                  class="rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-50"
                  :disabled="creating || !newTitle.trim()"
                >
                  Add card
                </button>
                <button
                  type="button"
                  class="text-sm text-fg-subtle hover:text-fg"
                  @click="addingIn = undefined"
                >
                  Cancel
                </button>
              </div>
            </form>
            <button
              v-else
              type="button"
              class="mt-2 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-fg-subtle transition hover:bg-surface hover:text-fg"
              @click="openAdd(column.key)"
            >
              <IconAdd class="h-4 w-4" /> Add card
            </button>
          </template>
        </section>

        <!-- Add column: at the end of the row, where the next column will go. -->
        <div v-if="editable && !phone" class="w-64 shrink-0">
          <form
            v-if="addingColumn"
            class="rounded-xl bg-surface-2 p-2"
            @submit.prevent="submitColumn"
          >
            <input
              id="board-new-column"
              v-model="newColumn"
              :class="inputClass"
              placeholder="Column name"
              @keydown.esc="addingColumn = false"
              @blur="submitColumn"
            />
          </form>
          <button
            v-else
            type="button"
            class="flex w-full items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-2.5 text-left text-sm text-fg-subtle transition hover:border-accent/50 hover:text-fg"
            @click="openAddColumn"
          >
            <IconAdd class="h-4 w-4" /> Add column
          </button>
        </div>
      </div>
    </template>

    <!-- Backdrop closes an open column menu or the Fields panel. -->
    <button
      v-if="menuColumn || fieldsOpen"
      type="button"
      tabindex="-1"
      aria-hidden="true"
      class="fixed inset-0 z-20 cursor-default"
      @click="((menuColumn = null), (fieldsOpen = false))"
    />
  </div>
</template>