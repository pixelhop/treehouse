import type { Component } from "vue";
import IconBook from "~icons/solar/book-2-linear";
import IconCode from "~icons/solar/code-square-linear";
import IconPlug from "~icons/solar/plug-circle-linear";
import IconNotebook from "~icons/solar/notebook-bookmark-linear";
import IconRocket from "~icons/solar/rocket-2-linear";
import IconFolder from "~icons/solar/folder-with-files-linear";
import IconUsers from "~icons/solar/users-group-rounded-linear";
import IconLaptop from "~icons/solar/laptop-minimalistic-linear";
import IconAgent from "~icons/solar/magic-stick-3-linear";
import IconTree from "~icons/solar/leaf-linear";
import IconCard from "~icons/solar/card-linear";
import IconHelp from "~icons/solar/help-linear";
import IconServer from "~icons/solar/server-2-linear";
import { docsSectionPath } from "~/utils/docs-tree";

/**
 * Icons for the docs areas (the sidebar's Docs | Agents switcher) and the
 * top-level sections. Kept here rather than in `docs-tree.ts` because that
 * module stays free of Vue so Nitro and nuxt.config can import it. A new
 * section renders without an icon until it gets an entry here.
 */
export const DOCS_AREA_ICONS: Record<string, Component> = {
  docs: IconBook,
  agents: IconAgent,
};

export const DOCS_SECTION_ICONS: Record<string, Component> = {
  "get-started": IconRocket,
  files: IconFolder,
  sharing: IconUsers,
  desktop: IconLaptop,
  agents: IconAgent,
  playbooks: IconTree,
  account: IconCard,
  help: IconHelp,
  "self-hosting": IconServer,
};

/**
 * Icons for the sub-sections that head the Agents sidebar
 * (`/docs/agents/<folder>`), which is one section split into three.
 */
export const DOCS_SUBSECTION_ICONS: Record<string, Component> = {
  "/docs/agents/connect": IconPlug,
  "/docs/agents/handbook": IconNotebook,
  "/docs/agents/reference": IconCode,
};

/** The icon for a section hub path (`/docs/files`, `/docs/agents/connect`), if it has one. */
export function docsSectionIcon(path: string): Component | undefined {
  const sub = DOCS_SUBSECTION_ICONS[path.replace(/\/+$/, "")];
  if (sub) return sub;
  const section = docsSectionPath(path);
  if (!section || section !== path.replace(/\/+$/, "")) return undefined;
  return DOCS_SECTION_ICONS[section.split("/")[2] ?? ""];
}