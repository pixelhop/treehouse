<script setup lang="ts">
import IconMore from "~icons/solar/menu-dots-bold";
import IconCalendar from "~icons/solar/calendar-linear";
import IconChecklist from "~icons/solar/checklist-minimalistic-linear";
import IconCheck from "~icons/solar/check-read-linear";
import IconWarning from "~icons/solar/danger-triangle-linear";
import {
  type BoardCard,
  type BoardColor,
  cardLabel,
  chipStyle,
  dotStyle,
  fieldColor,
  type FieldSpec,
  columnKey,
  assigneeInitials,
  type MemberLike,
  resolveAssignee,
  sameAssignee,
} from "~/utils/board";

// One card on a folder board. Everything on its face comes from the file:
// title, the chips for whichever keys the README's `card_fields` picks (`tags`
// by default), `due` (else `date`), `assignee`, and the body's task list.
// Moving and assigning are raised as events — the board owns the writes, and
// on a read-only board (`editable` false) there is no menu and no drag.
const props = defineProps<{
  card: BoardCard;
  members: MemberLike[];
  /** Columns offered by Move to…; the card's own column is marked. */
  columns: { name: string; color: BoardColor | null }[];
  /** Which front-matter keys show as chips, in order, with their value colours. */
  fields: FieldSpec[];
  editable: boolean;
  draggable: boolean;
  /** The card is being dragged right now (dimmed in place). */
  dragging?: boolean;
}>();
const emit = defineEmits<{
  open: [];
  move: [status: string | null];
  assign: [name: string];
  dragstart: [e: DragEvent];
  dragend: [];
}>();

const menu = ref<null | "main" | "move" | "assign">(null);

const label = computed(() => cardLabel(props.card));

// One chip per value of each chosen field, coloured when the README gives
// that value a colour.
const chips = computed(() =>
  props.fields.flatMap((field) =>
    (props.card.fields[field.name] ?? []).map((value) => ({
      key: `${field.name}\u0000${value}`,
      field: field.name,
      value,
      color: fieldColor(field, value),
    })),
  ),
);

const dueLabel = computed(() =>
  props.card.due
    ? new Date(`${props.card.due}T00:00:00`).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
      })
    : null,
);

// Each assignee resolved to a member when the name matches one; otherwise it
// renders as a plain initials chip (an agent, a client, someone not invited).
const people = computed(() =>
  props.card.assignees.map((name) => {
    const member = resolveAssignee(name, props.members);
    return { name, label: member?.name ?? name, image: member?.image ?? null, member: !!member };
  }),
);

const isAssigned = (name: string) =>
  props.card.assignees.some((a) => sameAssignee(a, name, props.members));

const inColumn = (label: string | null) =>
  label === null
    ? props.card.status === null
    : props.card.status !== null && columnKey(props.card.status) === columnKey(label);

function pickMove(status: string | null) {
  menu.value = null;
  if (!inColumn(status)) emit("move", status);
}

function pickAssign(name: string) {
  menu.value = null;
  emit("assign", name);
}

const itemClass =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-fg transition hover:bg-surface-2 lg:py-1.5";
</script>

<template>
  <div class="group relative">
    <div
      role="button"
      tabindex="0"
      :draggable="draggable"
      :aria-label="`Open ${label}`"
      class="block w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-left shadow-sm transition hover:border-accent/50 hover:shadow focus-visible:outline-2 focus-visible:outline-accent"
      :class="[
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        dragging ? 'opacity-40' : '',
      ]"
      @click="emit('open')"
      @keydown.enter.prevent="emit('open')"
      @keydown.space.prevent="emit('open')"
      @dragstart="emit('dragstart', $event)"
      @dragend="emit('dragend')"
    >
      <!-- ph-mask: card titles are user-authored names or front matter. -->
      <p class="ph-mask pr-6 text-sm leading-snug font-medium break-words text-fg">
        {{ label }}
      </p>

      <div v-if="chips.length" class="mt-2 flex flex-wrap gap-1">
        <!-- ph-mask: chip values are user-authored front matter. -->
        <span
          v-for="chip in chips"
          :key="chip.key"
          :title="`${chip.field}: ${chip.value}`"
          class="ph-mask rounded-full px-2 py-0.5 text-xs"
          :class="chip.color ? 'font-medium' : 'bg-surface-2 text-fg-muted'"
          :style="chip.color ? chipStyle(chip.color) : undefined"
          >{{ chip.value }}</span
        >
      </div>

      <div
        v-if="dueLabel || card.checklist || people.length || card.conflicted"
        class="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-subtle"
      >
        <span
          v-if="card.conflicted"
          class="inline-flex items-center gap-1 text-warning"
          title="Conflicted copy — both versions kept; resolve manually"
        >
          <IconWarning class="h-3.5 w-3.5" /> Conflicted copy
        </span>
        <span v-if="dueLabel" class="inline-flex items-center gap-1" :title="`Due ${card.due}`">
          <IconCalendar class="h-3.5 w-3.5" /> {{ dueLabel }}
        </span>
        <span
          v-if="card.checklist"
          class="inline-flex items-center gap-1"
          :class="card.checklist.done === card.checklist.total ? 'text-success' : ''"
          :title="`${card.checklist.done} of ${card.checklist.total} tasks done`"
        >
          <IconChecklist class="h-3.5 w-3.5" />
          {{ card.checklist.done }}/{{ card.checklist.total }}
        </span>
        <span v-if="people.length" class="ml-auto flex gap-1">
          <template v-for="person in people" :key="person.name">
            <!-- ph-mask: assignee names and avatars identify people. -->
            <img
              v-if="person.image"
              :src="person.image"
              :alt="person.label"
              :title="person.label"
              class="ph-mask h-6 w-6 rounded-full object-cover"
            />
            <span
              v-else
              :title="person.label"
              class="ph-mask grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold"
              :class="person.member ? 'bg-human/20 text-fg' : 'bg-surface-2 text-fg-muted'"
              >{{ assigneeInitials(person.label) }}</span
            >
          </template>
        </span>
      </div>
    </div>

    <!-- Move to… is the keyboard and touch alternative to dragging, so it is
         always reachable, not just on hover. -->
    <button
      v-if="editable"
      type="button"
      :aria-label="`Actions for ${label}`"
      :aria-expanded="menu !== null"
      class="absolute top-1.5 right-1.5 grid h-7 w-7 place-items-center rounded-md text-fg-subtle transition hover:bg-surface-2 hover:text-fg focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
      :class="menu ? 'lg:opacity-100' : ''"
      @click.stop="menu = menu ? null : 'main'"
    >
      <IconMore class="h-4 w-4" />
    </button>

    <div
      v-if="menu"
      class="absolute top-9 right-1.5 z-30 w-56 rounded-lg border border-border bg-surface p-1 shadow-lg"
      @keydown.esc.stop="menu = null"
    >
      <template v-if="menu === 'main'">
        <button type="button" :class="itemClass" @click="menu = 'move'">Move to…</button>
        <button type="button" :class="itemClass" @click="menu = 'assign'">Assign…</button>
        <button type="button" :class="itemClass" @click="((menu = null), emit('open'))">
          Open card
        </button>
      </template>
      <template v-else-if="menu === 'move'">
        <p class="px-2.5 pt-1.5 pb-1 text-xs font-medium text-fg-subtle">Move to</p>
        <!-- ph-mask: column names are user-authored front matter. -->
        <button
          v-for="col in columns"
          :key="col.name"
          type="button"
          :class="itemClass"
          @click="pickMove(col.name)"
        >
          <span
            class="h-2.5 w-2.5 shrink-0 rounded-full"
            :class="col.color ? '' : 'border border-fg-subtle/60'"
            :style="col.color ? dotStyle(col.color) : undefined"
          />
          <span class="ph-mask min-w-0 flex-1 truncate">{{ col.name }}</span>
          <IconCheck v-if="inColumn(col.name)" class="h-4 w-4 shrink-0 text-accent" />
        </button>
        <button type="button" :class="itemClass" @click="pickMove(null)">
          <span class="min-w-0 flex-1 truncate text-fg-muted">No status</span>
          <IconCheck v-if="inColumn(null)" class="h-4 w-4 shrink-0 text-accent" />
        </button>
      </template>
      <template v-else>
        <p class="px-2.5 pt-1.5 pb-1 text-xs font-medium text-fg-subtle">Assign</p>
        <p v-if="!members.length" class="px-2.5 py-1.5 text-sm text-fg-muted">
          No members to assign.
        </p>
        <!-- ph-mask: member names identify people. -->
        <button
          v-for="m in members"
          :key="m.id"
          type="button"
          :class="itemClass"
          @click="pickAssign(m.name)"
        >
          <img
            v-if="m.image"
            :src="m.image"
            alt=""
            class="ph-mask h-5 w-5 shrink-0 rounded-full object-cover"
          />
          <span
            v-else
            class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-human/20 text-[9px] font-semibold text-fg"
            >{{ assigneeInitials(m.name) }}</span
          >
          <span class="ph-mask min-w-0 flex-1 truncate">{{ m.name }}</span>
          <IconCheck v-if="isAssigned(m.name)" class="h-4 w-4 shrink-0 text-accent" />
        </button>
        <!-- Assigned names that aren't members (an agent, a client) can be
             cleared from here too; they're added by editing the file. -->
        <template v-for="person in people" :key="`x-${person.name}`">
          <button
            v-if="!person.member"
            type="button"
            :class="itemClass"
            @click="pickAssign(person.name)"
          >
            <span
              class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[9px] font-semibold text-fg-muted"
              >{{ assigneeInitials(person.name) }}</span
            >
            <span class="ph-mask min-w-0 flex-1 truncate">{{ person.name }}</span>
            <IconCheck class="h-4 w-4 shrink-0 text-accent" />
          </button>
        </template>
      </template>
    </div>
    <!-- Backdrop closes the menu. -->
    <button
      v-if="menu"
      type="button"
      tabindex="-1"
      aria-hidden="true"
      class="fixed inset-0 z-20 cursor-default"
      @click="menu = null"
    />
  </div>
</template>