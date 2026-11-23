<script setup lang="ts">
/**
 * The product shot: the real app's chrome, rendered honestly.
 *
 * Every class in the window below is the class the app itself uses — the layout
 * is `layouts/app.vue`, the sidebar is `AppSidebar.vue` + `FileTree.vue`, the
 * header is `AppTopBar.vue` + `WorkspaceView.vue`'s actions, and the palette is
 * the app's own --th-* variables (see main.css). If those change, this should
 * change with them; a product shot that flatters is worse than none.
 *
 * Deliberate differences:
 *
 *  - The details panel is collapsed, so the reading column gets the width. The
 *    toggle is drawn in its inactive state to match.
 *  - Only the sidebar toggle does anything. The app's other buttons are spans,
 *    and the whole window is hidden from assistive tech, because a screenful of
 *    focusable elements that do nothing is worse than a picture. The toggle is
 *    a real button but tabindex="-1": pointer-only, out of the tab order, and
 *    out of the a11y tree with everything else around it.
 *
 * Below md the sidebar would leave the reading column about 120px wide, which
 * is what the app itself does and is no use to anyone here — so it starts
 * closed and opens under the top bar with the window to itself. The bar stays
 * put, so the same button closes it again.
 *
 * The theme switcher below the window is the one control offered to everybody,
 * and it is a real one — those are the app's seven built-in themes, not seven
 * repaints of a mock.
 */
import IconSidebarToggle from "~icons/solar/sidebar-minimalistic-bold-duotone";
import IconSearch from "~icons/solar/magnifer-linear";
import IconMore from "~icons/solar/menu-dots-bold";
import IconChevronDown from "~icons/solar/alt-arrow-down-linear";
import IconChevronUp from "~icons/solar/alt-arrow-up-linear";
import IconChevronRight from "~icons/solar/alt-arrow-right-linear";
import IconFileLinear from "~icons/solar/file-text-linear";
import IconFolderLinear from "~icons/solar/folder-with-files-linear";
import IconUpload from "~icons/solar/upload-minimalistic-linear";
import IconHistory from "~icons/solar/history-2-linear";
import IconFile from "~icons/solar/file-text-bold-duotone";
import IconFolder from "~icons/solar/folder-bold-duotone";
import {
  DEMO_THEMES,
  demoExpanded,
  demoMap,
  demoTree,
  type DemoThemeId,
} from "~/composables/useDemoWorkspace";

const theme = ref<DemoThemeId>("treehouse");

// Open by default where there is room for it beside the reading column, closed
// where there isn't. Read during setup rather than onMounted — the site is a
// client-only SPA, so this avoids a frame of open sidebar on a phone.
const WIDE = "(min-width: 768px)";
const sidebarOpen = ref(import.meta.client ? window.matchMedia(WIDE).matches : true);

onMounted(() => {
  // Only fires on crossing the breakpoint, so this restores the sensible
  // default for the new width rather than fighting a choice already made.
  const mq = window.matchMedia(WIDE);
  const sync = () => (sidebarOpen.value = mq.matches);
  mq.addEventListener("change", sync);
  onBeforeUnmount(() => mq.removeEventListener("change", sync));
});
</script>

<template>
  <div>
    <!--
      The window. `text-sm` is the app shell's base size; every size below is
      relative to it, so the whole thing scales with one number if it ever needs
      to sit somewhere tighter.
    -->
    <div
      :data-demo-theme="theme"
      aria-hidden="true"
      class="app-demo flex h-[30rem] select-none flex-col overflow-hidden rounded-2xl border border-th-border bg-th-surface text-th-fg shadow-lg sm:h-[34rem] md:flex-row lg:h-[38rem]"
    >
      <!--
        ============ Sidebar (layouts/app.vue → AppSidebar.vue) ============
        Beside the main pane from md, under the top bar below it — hence the
        order swap and the border moving from the right edge to the top.
      -->
      <aside
        class="w-full shrink-0 border-th-border md:w-[272px] md:border-r"
        :class="
          sidebarOpen
            ? 'order-2 flex min-h-0 flex-1 border-t md:order-1 md:flex-none md:border-t-0'
            : 'hidden'
        "
      >
        <div class="flex h-full w-full flex-col bg-th-surface-2">
          <!-- WorkspaceSwitcher -->
          <div class="flex w-full items-center gap-2 px-3 py-3 text-left">
            <span
              class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-rose-500 text-lg text-white"
              >🏡</span
            >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold text-th-fg">Fernhill Studio</span>
              <span class="block truncate text-xs text-th-fg-muted">Workspace</span>
            </span>
            <IconChevronDown class="h-4 w-4 shrink-0 text-th-fg-subtle" />
          </div>

          <!-- Filter + tree options -->
          <div class="flex items-center gap-1 px-2 pt-1">
            <div class="relative flex-1">
              <IconSearch
                class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-th-fg-subtle"
              />
              <div
                class="w-full rounded-md border border-th-border bg-th-surface py-1 pl-7 pr-2 text-sm text-th-fg-subtle"
              >
                Filter files…
              </div>
            </div>
            <div
              class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-th-fg-subtle"
              aria-hidden="true"
            >
              <IconMore class="h-4 w-4" />
            </div>
          </div>

          <!-- New file / folder / upload -->
          <div class="flex items-center gap-1 px-2 pt-1">
            <span
              class="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-th-border px-2 py-1 text-xs text-th-fg-muted"
            >
              <IconFileLinear class="h-3.5 w-3.5" /> New file
            </span>
            <span
              class="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-th-border px-2 py-1 text-xs text-th-fg-muted"
            >
              <IconFolderLinear class="h-3.5 w-3.5" /> New folder
            </span>
            <span
              class="flex items-center justify-center rounded-md border border-th-border px-2 py-1 text-xs text-th-fg-muted"
            >
              <IconUpload class="h-3.5 w-3.5" />
            </span>
          </div>

          <!--
            Scrolls, like the app's does. The workspace is deliberately bigger
            than the window: a tree that happens to fit exactly reads as a
            diagram, and the cut-off row is the honest signal that there is more.
          -->
          <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1">
            <ul class="space-y-0.5">
              <li v-for="node in demoTree" :key="node.name">
                <div class="flex items-center gap-0.5 rounded-md pr-1">
                  <span
                    v-if="node.isDir"
                    class="grid shrink-0 place-items-center rounded p-1 text-th-fg-subtle"
                  >
                    <IconChevronRight
                      class="h-3.5 w-3.5"
                      :class="demoExpanded.has(node.name) ? 'rotate-90' : ''"
                    />
                  </span>
                  <span v-else class="w-[22px] shrink-0" />

                  <span class="grid shrink-0 place-items-center rounded p-1.5 text-th-fg-subtle">
                    <span v-if="node.icon" class="grid h-4 w-4 place-items-center leading-none">{{
                      node.icon
                    }}</span>
                    <component :is="node.isDir ? IconFolder : IconFile" v-else class="h-4 w-4" />
                  </span>

                  <span
                    class="min-w-0 flex-1 truncate py-1 text-left text-sm"
                    :class="node.isDir ? 'text-th-fg-muted' : 'text-th-fg'"
                    >{{ node.name }}</span
                  >
                </div>

                <div
                  v-if="node.children && demoExpanded.has(node.name)"
                  class="ml-3 border-l border-th-border pl-2"
                >
                  <ul class="space-y-0.5">
                    <li v-for="child in node.children" :key="child.name">
                      <div class="flex items-center gap-0.5 rounded-md pr-1">
                        <span
                          v-if="child.isDir"
                          class="grid shrink-0 place-items-center rounded p-1 text-th-fg-subtle"
                        >
                          <IconChevronRight class="h-3.5 w-3.5" />
                        </span>
                        <span v-else class="w-[22px] shrink-0" />
                        <span
                          class="grid shrink-0 place-items-center rounded p-1.5 text-th-fg-subtle"
                        >
                          <span
                            v-if="child.icon"
                            class="grid h-4 w-4 place-items-center leading-none"
                            >{{ child.icon }}</span
                          >
                          <component
                            :is="child.isDir ? IconFolder : IconFile"
                            v-else
                            class="h-4 w-4"
                          />
                        </span>
                        <span
                          class="min-w-0 flex-1 truncate py-1 text-left text-sm"
                          :class="child.isDir ? 'text-th-fg-muted' : 'text-th-fg'"
                          >{{ child.name }}</span
                        >
                      </div>
                    </li>
                  </ul>
                </div>
              </li>
            </ul>
          </div>

          <!-- Account -->
          <div class="border-t border-th-border p-2">
            <div class="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left">
              <span
                class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-th-surface-2 text-xs font-medium text-th-fg"
                >S</span
              >
              <span class="min-w-0 flex-1 truncate text-sm text-th-fg">Sam Rivera</span>
              <IconChevronUp class="h-4 w-4 shrink-0 text-th-fg-subtle" />
            </div>
          </div>
        </div>
      </aside>

      <!-- ============ Main (AppTopBar.vue + WorkspaceView.vue) ============ -->
      <main
        class="order-1 flex min-w-0 flex-col overflow-hidden md:order-2 md:flex-1"
        :class="sidebarOpen ? 'shrink-0 md:shrink' : 'flex-1'"
      >
        <header
          class="flex h-12 shrink-0 items-center gap-1 border-b border-th-border px-3 text-sm"
        >
          <!--
            The one live control in here. tabindex="-1" keeps it out of the tab
            order: it sits inside an aria-hidden window, and a focusable element
            in there would be a trap with nothing to read at the end of it.
          -->
          <button
            type="button"
            tabindex="-1"
            class="mr-1 cursor-pointer rounded-md p-1.5 text-th-fg-muted transition hover:bg-th-surface-2"
            @click="sidebarOpen = !sidebarOpen"
          >
            <IconSidebarToggle class="h-4 w-4" />
          </button>
          <span class="rounded px-1.5 py-1 text-th-fg-muted">Fernhill Studio</span>

          <div class="ml-auto flex items-center gap-1">
            <!-- Folder view switcher: default page ⇄ file listing. -->
            <div
              class="hidden items-center gap-0.5 rounded-lg border border-th-border bg-th-surface p-0.5 sm:flex"
            >
              <span class="rounded-md bg-th-surface-2 px-2.5 py-1 text-sm font-medium text-th-fg"
                >README.md</span
              >
              <span class="rounded-md px-2.5 py-1 text-sm text-th-fg-muted">Files</span>
            </div>
            <span class="hidden rounded-md px-2.5 py-1.5 text-th-fg-muted lg:inline"
              >Open file</span
            >
            <span class="relative rounded-md p-1.5 text-th-fg-muted">
              <IconHistory class="h-4 w-4" />
              <span
                class="absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-th-accent px-1 text-[10px] font-semibold leading-none text-th-accent-fg ring-2 ring-th-surface"
                >3</span
              >
            </span>
            <span class="hidden rounded-md px-2.5 py-1.5 text-th-fg-muted sm:inline">Refresh</span>
            <!-- Details panel collapsed: the toggle sits in its inactive state. -->
            <span class="rounded-md p-1.5 text-th-fg-muted">
              <IconSidebarToggle class="h-4 w-4 -scale-x-100" />
            </span>
          </div>
        </header>

        <!--
          The reading column. Same max-width and padding as the app's viewer,
          and the type below is the app's prose scale rather than this site's —
          the window has to look like the app, not like the page around it.
        -->
        <div class="min-h-0 flex-1 overflow-y-auto" :class="sidebarOpen ? 'hidden md:block' : ''">
          <div class="mx-auto max-w-3xl px-5 py-6 sm:px-8 sm:py-8">
            <h1 class="text-3xl font-bold tracking-tight text-th-fg">🌿 Fernhill Home</h1>

            <p class="mt-5 leading-7 text-th-fg">
              Welcome to the Fernhill Studio home — our shared
              <strong class="font-semibold">second brain</strong>. Have a look around!
            </p>
            <p class="mt-4 leading-7 text-th-fg">
              Everything we know lives here as plain Markdown, so that
              <strong class="font-semibold">both people and AI agents</strong> can read it, add to
              it, and keep it tidy. It lives in a folder on your machine that's two-way synced. Edit
              a file and it syncs; someone else edits it and you get their change.
            </p>

            <h2 class="mt-8 text-xl font-semibold text-th-fg">Start here</h2>
            <ul class="mt-3 space-y-2">
              <li class="flex gap-2 leading-7 text-th-fg">
                <span class="text-th-fg-subtle">•</span>
                <span
                  >New here? →
                  <code
                    class="rounded bg-th-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-th-accent"
                    >About-Us/</code
                  ></span
                >
              </li>
              <li class="flex gap-2 leading-7 text-th-fg">
                <span class="text-th-fg-subtle">•</span>
                <span
                  >Looking for how we work? →
                  <code
                    class="rounded bg-th-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-th-accent"
                    >Ways-of-Working/</code
                  ></span
                >
              </li>
              <li class="flex gap-2 leading-7 text-th-fg">
                <span class="text-th-fg-subtle">•</span>
                <span
                  >Just want to dump a thought? → drop it in
                  <code
                    class="rounded bg-th-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-th-accent"
                    >Inbox/</code
                  >
                  and don't think about where it goes. It gets sorted later.</span
                >
              </li>
            </ul>

            <h2 class="mt-8 text-xl font-semibold text-th-fg">The map</h2>
            <table class="mt-3 w-full text-left">
              <thead>
                <tr class="border-b border-th-border">
                  <th class="pb-2 pr-4 text-sm font-semibold text-th-fg">Section</th>
                  <th class="pb-2 text-sm font-semibold text-th-fg">What's inside</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in demoMap" :key="row.name" class="border-b border-th-border">
                  <td class="py-2.5 pr-4 align-top">
                    <span class="whitespace-nowrap text-th-accent">
                      {{ row.icon }}
                      <span class="underline underline-offset-4">{{ row.name }}</span>
                    </span>
                  </td>
                  <td class="py-2.5 align-top text-th-fg">{{ row.blurb }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>

    <!-- ============ Theme switcher ============ -->
    <div class="mt-5 flex flex-wrap items-center justify-center gap-2">
      <p class="label-eyebrow mr-1 w-full text-center sm:w-auto sm:text-left">Try a theme</p>
      <button
        v-for="t in DEMO_THEMES"
        :key="t.id"
        type="button"
        class="lift flex items-center gap-2 rounded-full border bg-surface py-1.5 pl-1.5 pr-3.5 text-xs font-semibold"
        :class="
          theme === t.id
            ? 'border-leaf text-leaf-deep ring-1 ring-leaf'
            : 'border-border text-fg-muted hover:border-sage hover:text-fg'
        "
        :aria-pressed="theme === t.id"
        @click="theme = t.id"
      >
        <span
          class="flex h-5 w-5 shrink-0 overflow-hidden rounded-full border border-border"
          aria-hidden="true"
        >
          <span v-for="c in t.swatch" :key="c" class="flex-1" :style="{ background: c }" />
        </span>
        {{ t.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * The panes scroll, so their scrollbars have to follow the demo's palette
 * rather than the page's — a cream-on-cream scrollbar over the Dracula theme
 * would give the whole thing away.
 */
.app-demo :deep(*) {
  scrollbar-width: thin;
  scrollbar-color: var(--th-border) transparent;
}
</style>