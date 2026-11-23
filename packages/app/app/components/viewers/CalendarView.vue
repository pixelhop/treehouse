<script setup lang="ts">
import {
  addMonths,
  buildMonthGrid,
  decideReschedule,
  groupByDate,
  monthLabel,
  WEEKDAYS_MON_FIRST,
} from "~/utils/calendar";
import { withoutMarkdownExtension } from "shared";
import type { DatedChild } from "~/utils/folderDates";
import type { RescheduleResult } from "~/composables/useCalendarReschedule";
import IconLeft from "~icons/solar/alt-arrow-left-linear";
import IconRight from "~icons/solar/alt-arrow-right-linear";

// Rescheduling is an INJECTED CAPABILITY, not something this component reaches
// for. It used to call `useCalendarReschedule()` itself — but that writes through
// `useWorkspaceData()`, and this same component renders inside a public share,
// where there is no route workspace id and so that composable resolves to the
// VISITOR'S OWN last-opened workspace. Dragging an entry on a stranger's shared
// calendar would read and write a same-path file in your own workspace.
//
// With the writer passed in, a read-only surface simply doesn't pass one: the
// share never constructs the workspace composable at all, so there is no write
// path to reach rather than a flag guarding one. `decideReschedule` re-checks it
// anyway, so the boundary holds even if a drop handler is ever wired up by hand.
const props = defineProps<{
  name: string;
  children: DatedChild[];
  reschedule?: (path: string, date: string) => Promise<RescheduleResult>;
}>();
const emit = defineEmits<{ select: [node: { path: string; isDir: boolean }] }>();

const canReschedule = computed(() => !!props.reschedule);

// How many entry chips a day cell shows before collapsing the rest behind a
// "+N more" control (keeps cells uniform when a day is busy — R7 still holds,
// every entry stays reachable via the day popover).
const MAX_CHIPS = 3;

const now = new Date();
const todayYear = now.getFullYear();
const todayMonth = now.getMonth() + 1;
const today = `${String(todayYear).padStart(4, "0")}-${String(todayMonth).padStart(2, "0")}-${String(
  now.getDate(),
).padStart(2, "0")}`;

// Open on the current month.
const viewYear = ref(todayYear);
const viewMonth = ref(todayMonth);
// Which day's "+N more" popover is open, by date key.
const openDay = ref<string | null>(null);

// Optimistic reschedule overrides (path -> new date), layered over props so a
// dragged chip moves immediately. Cleared when the refetched props catch up
// (success) or when the write fails (snap back).
const overrides = reactive(new Map<string, string>());
// Paths with a reschedule write in flight — a second drop is ignored until the
// first settles, so two fast drags can't both read the same base version and
// make the later one lose the version race (server-stashed conflicted copy).
const pending = reactive(new Set<string>());
const displayChildren = computed(() =>
  props.children.map((c) => {
    const next = overrides.get(c.path);
    return next ? { ...c, date: next } : c;
  }),
);

// Each version bump rebuilds `props.children` with a new array identity, so a
// shallow watch is enough. Clear an override once the refetched prop carries the
// new date (success) or once its file is gone (deleted) so the map can't grow.
watch(
  () => props.children,
  (kids) => {
    for (const [path, date] of overrides) {
      const current = kids.find((c) => c.path === path);
      // Clear only once the refetched prop actually carries the new date. Do not
      // prune on absence: a file is transiently missing while its version-bumped
      // read is in flight, and clearing then makes the chip vanish mid-reschedule.
      if (current && current.date === date) overrides.delete(path);
    }
  },
);

const cells = computed(() => buildMonthGrid(viewYear.value, viewMonth.value, today).flat());
const grouped = computed(() => groupByDate(displayChildren.value));
const label = computed(() => monthLabel(viewYear.value, viewMonth.value));

// A seven-column month grid needs about 560px to be readable. Below that it
// truncated every entry to a syllable ("Fir…", "Se…", "Th…"), which is a grid
// that shows you nothing. So on a compact screen the same month renders as an
// agenda: the days that actually have entries, in order, with room for their
// titles. Same data, same month navigation, a shape that fits.
const compact = useCompactLayout();

const agendaDays = computed(() =>
  cells.value
    .filter((cell) => cell.inMonth && entriesFor(cell.date).length > 0)
    .map((cell) => ({ ...cell, entries: entriesFor(cell.date) })),
);

const dayHeading = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

// --- drag-to-reschedule state ---
const dragPath = ref<string | null>(null);
const hoverDate = ref<string | null>(null);
type CalendarNotice =
  | { kind: "conflict"; label: string; conflictCopyPath?: string }
  | { kind: "error"; label: string };
const notice = ref<CalendarNotice | null>(null);

function step(delta: number) {
  const next = addMonths(viewYear.value, viewMonth.value, delta);
  viewYear.value = next.year;
  viewMonth.value = next.month;
  openDay.value = null;
}

function goToday() {
  viewYear.value = todayYear;
  viewMonth.value = todayMonth;
  openDay.value = null;
}

function entriesFor(date: string): DatedChild[] {
  return grouped.value[date] ?? [];
}

function chipLabel(child: DatedChild): string {
  return child.title ?? withoutMarkdownExtension(child.name);
}

function labelForPath(path: string): string {
  const child = props.children.find((c) => c.path === path);
  return child ? chipLabel(child) : path;
}

function openEntry(child: DatedChild) {
  emit("select", { path: child.path, isDir: false });
}

function onDragStart(child: DatedChild, e: DragEvent) {
  if (!canReschedule.value) return;
  openDay.value = null; // close any day popover so its backdrop can't block drops
  dragPath.value = child.path;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onDragEnd() {
  dragPath.value = null;
  hoverDate.value = null;
}

function onDragOver(date: string, e: DragEvent) {
  if (!canReschedule.value || !dragPath.value) return;
  e.preventDefault(); // mark the cell as a valid drop target
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  hoverDate.value = date;
}

async function onDrop(date: string) {
  const dragged = dragPath.value;
  dragPath.value = null;
  hoverDate.value = null;

  const child = dragged ? props.children.find((c) => c.path === dragged) : undefined;
  const decision = decideReschedule({
    canReschedule: canReschedule.value,
    dragPath: dragged,
    currentDate: child ? (overrides.get(child.path) ?? child.date) : undefined,
    toDate: date,
    inFlight: !!dragged && pending.has(dragged),
  });
  if (!decision.proceed) return;
  const path = decision.path;

  pending.add(path);
  overrides.set(path, date); // optimistic move
  try {
    const result = await props.reschedule!(path, date);
    if (result.status === "ok") return; // keep override until refetch catches up

    overrides.delete(path); // snap back
    notice.value =
      result.status === "conflict"
        ? {
            kind: "conflict",
            label: labelForPath(path),
            conflictCopyPath: result.conflictCopyPath,
          }
        : {
            kind: "error",
            label: labelForPath(path),
          };
  } finally {
    pending.delete(path);
  }
}
</script>

<template>
  <div class="space-y-4">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="min-w-0 truncate text-lg font-semibold text-fg">
        <!-- ph-mask: a calendar heading may come from user-authored front matter or a folder name. -->
        <span v-if="name" class="ph-mask">{{ name }}</span>
        <span v-else>Calendar</span>
      </h2>
      <div class="flex shrink-0 items-center gap-1">
        <span class="mr-1 text-sm font-medium text-fg-muted">{{ label }}</span>
        <button
          type="button"
          title="Previous month"
          class="grid h-9 w-9 place-items-center rounded-md text-fg-muted transition hover:bg-surface-2 lg:h-auto lg:w-auto lg:p-1.5"
          @click="step(-1)"
        >
          <IconLeft class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-2 text-sm text-fg-muted transition hover:bg-surface-2 lg:px-2 lg:py-1"
          @click="goToday"
        >
          Today
        </button>
        <button
          type="button"
          title="Next month"
          class="grid h-9 w-9 place-items-center rounded-md text-fg-muted transition hover:bg-surface-2 lg:h-auto lg:w-auto lg:p-1.5"
          @click="step(1)"
        >
          <IconRight class="h-4 w-4" />
        </button>
      </div>
    </header>

    <div
      v-if="notice"
      class="flex items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg"
    >
      <span class="min-w-0 flex-1">
        <template v-if="notice.kind === 'conflict'">
          “<!-- ph-mask: the label and copy path are user-authored file data. --><span
            class="ph-mask"
            >{{ notice.label }}</span
          >” changed on the server, so your reschedule was kept as a copy<span
            v-if="notice.conflictCopyPath"
            >: <span class="ph-mask">{{ notice.conflictCopyPath }}</span></span
          >.
        </template>
        <template v-else>
          Couldn't reschedule “<!-- ph-mask: the label is a user-authored file name or title. --><span
            class="ph-mask"
            >{{ notice.label }}</span
          >” — it may have changed. Refresh and try again.
        </template>
      </span>
      <button type="button" class="shrink-0 text-fg-muted hover:text-fg" @click="notice = null">
        Dismiss
      </button>
    </div>

    <!-- Compact: an agenda of the month's populated days. Drag-to-reschedule has
         no touch equivalent, so it isn't offered here — the entry's own page
         still edits the date, and the grid is a rotation or a wider screen
         away. -->
    <div v-if="compact" class="space-y-4">
      <p v-if="!agendaDays.length" class="text-sm text-fg-subtle">Nothing dated in {{ label }}.</p>
      <section v-for="day in agendaDays" :key="day.date" class="space-y-1">
        <h3
          class="flex items-center gap-2 text-xs font-medium tracking-wide uppercase"
          :class="day.isToday ? 'text-accent' : 'text-fg-subtle'"
        >
          {{ dayHeading(day.date) }}
          <span v-if="day.isToday" class="rounded-full bg-accent px-1.5 py-0.5 text-accent-fg">
            Today
          </span>
        </h3>
        <!-- ph-mask: calendar entry labels come from file names or front-matter titles. -->
        <ul class="overflow-hidden rounded-lg border border-border">
          <li
            v-for="entry in day.entries"
            :key="entry.path"
            class="border-b border-border last:border-b-0"
          >
            <button
              type="button"
              class="ph-mask block w-full px-3 py-3 text-left text-sm text-fg transition hover:bg-surface-2"
              @click="openEntry(entry)"
            >
              {{ chipLabel(entry) }}
            </button>
          </li>
        </ul>
      </section>
    </div>

    <!-- No `overflow-hidden`: it would clip a bottom-row day's "+N more" popover.
         Corners are rounded on the header and the last-row corner cells instead. -->
    <div v-else class="rounded-lg border border-border">
      <div class="grid grid-cols-7 rounded-t-lg border-b border-border bg-surface-2">
        <div
          v-for="day in WEEKDAYS_MON_FIRST"
          :key="day"
          class="px-2 py-1.5 text-center text-xs font-medium text-fg-subtle"
        >
          {{ day }}
        </div>
      </div>

      <div
        class="grid grid-cols-7 [&>*:last-child]:rounded-br-lg [&>*:nth-last-child(7)]:rounded-bl-lg"
      >
        <div
          v-for="cell in cells"
          :key="cell.date"
          class="relative min-h-[6rem] border-t border-l border-border p-1 transition first:border-l-0 [&:nth-child(7n+1)]:border-l-0"
          :class="[
            cell.inMonth ? 'bg-surface' : 'bg-app',
            dragPath && hoverDate === cell.date ? 'ring-2 ring-accent ring-inset' : '',
          ]"
          @dragover="canReschedule && onDragOver(cell.date, $event)"
          @drop="canReschedule && onDrop(cell.date)"
        >
          <div class="mb-1 flex justify-end">
            <span
              class="flex h-5 w-5 items-center justify-center rounded-full text-xs"
              :class="[
                cell.isToday ? 'bg-accent font-semibold text-accent-fg' : '',
                !cell.isToday && cell.inMonth ? 'text-fg-muted' : '',
                !cell.isToday && !cell.inMonth ? 'text-fg-subtle' : '',
              ]"
            >
              {{ cell.day }}
            </span>
          </div>

          <!-- ph-mask: chip text is a user-authored file name or title. -->
          <ul class="space-y-0.5">
            <li v-for="entry in entriesFor(cell.date).slice(0, MAX_CHIPS)" :key="entry.path">
              <button
                type="button"
                :draggable="canReschedule"
                :title="chipLabel(entry)"
                class="ph-mask block w-full truncate rounded bg-surface-2 px-1.5 py-0.5 text-left text-xs text-fg transition hover:bg-accent hover:text-accent-fg"
                :class="canReschedule ? 'cursor-grab active:cursor-grabbing' : ''"
                @click="openEntry(entry)"
                @dragstart="onDragStart(entry, $event)"
                @dragend="onDragEnd"
              >
                {{ chipLabel(entry) }}
              </button>
            </li>
          </ul>

          <button
            v-if="entriesFor(cell.date).length > MAX_CHIPS"
            type="button"
            class="mt-0.5 px-1.5 text-xs text-fg-subtle transition hover:text-fg"
            @click="openDay = cell.date"
          >
            +{{ entriesFor(cell.date).length - MAX_CHIPS }} more
          </button>

          <div
            v-if="openDay === cell.date"
            class="absolute top-1 left-1 z-20 max-h-64 w-[calc(100%-0.5rem)] overflow-auto rounded-md border border-border bg-surface p-1.5 shadow-lg"
          >
            <div class="mb-1 px-1 text-xs font-medium text-fg-subtle">{{ cell.date }}</div>
            <!-- ph-mask: expanded chip text is a user-authored file name or title. -->
            <ul class="space-y-0.5">
              <li v-for="entry in entriesFor(cell.date)" :key="entry.path">
                <button
                  type="button"
                  :draggable="canReschedule"
                  :title="chipLabel(entry)"
                  class="ph-mask block w-full truncate rounded px-1.5 py-0.5 text-left text-xs text-fg transition hover:bg-accent hover:text-accent-fg"
                  :class="canReschedule ? 'cursor-grab active:cursor-grabbing' : ''"
                  @click="openEntry(entry)"
                  @dragstart="onDragStart(entry, $event)"
                  @dragend="onDragEnd"
                >
                  {{ chipLabel(entry) }}
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Backdrop closes any open day popover. -->
    <button
      v-if="openDay"
      type="button"
      tabindex="-1"
      aria-hidden="true"
      class="fixed inset-0 z-10 cursor-default"
      @click="openDay = null"
    />
  </div>
</template>