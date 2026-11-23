// The board's write capability: moving, creating and assigning cards, and
// editing the folder README's `columns`. Constructed only in the authenticated
// workspace surface and handed to BoardView as a prop — the public share renders
// the same component without it and so has no write path at all (the calendar's
// pattern; see CalendarView).
//
// Every action is a plain file write through the version-CAS file service: a
// card move patches one card's front matter, a column edit patches the README.
import type { FrontMatterWriteResult } from "~/composables/useFrontMatterWrite";
import type { WorkspaceMember } from "~/composables/useTreehouseApi";
import {
  type BoardCard,
  boardDeclarationPatch,
  cardFileName,
  cardStatus,
  columnKey,
  type ColumnSpec,
  type FieldSpec,
  serializeCardFields,
  newBoardReadme,
  serializeColumns,
  stringList,
  toggledAssignee,
} from "~/utils/board";
import type { FrontMatterData } from "~/utils/frontmatterData";
import { loadFrontMatterData } from "~/utils/frontmatterFields";
import { isMarkdownPath } from "shared";

/** What a board needs to know about its folder to write to it. */
export interface BoardContext {
  /** Folder path; "" for the workspace root. */
  folderPath: string;
  /** Used as the `title` of a README the board has to create. */
  folderName: string;
  /** The folder's default page (README/index), when it has one. */
  defaultPagePath: string | null;
  defaultPageFrontMatter: FrontMatterData | null;
  /** Every child file name, so a new card never collides with one. */
  childNames: string[];
}

export type CreateCardResult = { status: "ok"; path: string } | { status: "error" };

export interface BoardActions {
  members: WorkspaceMember[];
  /** Set a card's column (null = No status) and, optionally, its order (null removes it). */
  move: (
    path: string,
    to: { status: string | null; order?: number | null },
  ) => Promise<FrontMatterWriteResult>;
  createCard: (title: string, status: string | null) => Promise<CreateCardResult>;
  /** Replace the README's `columns` with `columns` (names and colours). */
  setColumns: (columns: ColumnSpec[]) => Promise<FrontMatterWriteResult>;
  /** Replace the README's `card_fields`: which keys show as chips, and their colours. */
  setCardFields: (fields: FieldSpec[]) => Promise<FrontMatterWriteResult>;
  /** Rename a column: the README list, then every card in it. Returns the cards that failed. */
  renameColumn: (
    columns: ColumnSpec[],
    from: string,
    to: string,
    cards: BoardCard[],
  ) => Promise<{ readme: FrontMatterWriteResult; failed: string[] }>;
  toggleAssignee: (card: BoardCard, name: string) => Promise<FrontMatterWriteResult>;
}

export function useBoardActions() {
  const ws = useWorkspaceData();
  const api = useTreehouseApi();
  const { patch } = useFrontMatterWrite();
  const { list: members } = useWorkspaceMembers(ws.workspaceId);

  const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

  /**
   * Patch the folder's README front matter, creating `README.md` when the folder
   * has no default page. An `index.html` default page has no front matter to
   * hold a board declaration, so that case is refused rather than guessed at.
   */
  async function patchReadme(
    ctx: BoardContext,
    fields: Record<string, unknown>,
    workspaceId = ws.workspaceId.value,
  ): Promise<FrontMatterWriteResult> {
    if (ctx.defaultPagePath) {
      if (!isMarkdownPath(ctx.defaultPagePath)) return { status: "error" };
      return patch(ctx.defaultPagePath, fields, { workspaceId });
    }
    const id = workspaceId;
    if (!id) return { status: "error" };
    try {
      const source = await newBoardReadme(ctx.folderName, fields);
      const res = await api.createFile(id, join(ctx.folderPath, "README.md"), source);
      return res.ok ? { status: "ok" } : { status: "conflict" };
    } catch {
      return { status: "error" };
    } finally {
      ws.refresh();
    }
  }

  function bind(ctx: BoardContext): BoardActions {
    return {
      members: members.value,
      move: (path, to) => {
        const fields: Record<string, unknown> = { status: to.status ?? undefined };
        if (to.order !== undefined) fields.order = to.order ?? undefined;
        return patch(path, fields);
      },
      async createCard(title, status) {
        const id = ws.workspaceId.value;
        if (!id) return { status: "error" };
        const path = join(ctx.folderPath, cardFileName(title, ctx.childNames));
        const fm: Record<string, unknown> = { title };
        if (status !== null) fm.status = status;
        try {
          const { serializeFrontMatter } = await loadFrontMatterData();
          const res = await api.createFile(id, path, serializeFrontMatter(fm));
          return res.ok ? { status: "ok", path } : { status: "error" };
        } catch {
          return { status: "error" };
        } finally {
          ws.refresh();
        }
      },
      setColumns: (columns) => patchReadme(ctx, { columns: serializeColumns(columns) }),
      setCardFields: (fields) => patchReadme(ctx, { card_fields: serializeCardFields(fields) }),
      async renameColumn(columns, from, to, cards) {
        // The whole batch is pinned to the workspace it started in: it spans
        // several awaited writes, and switching workspace part-way must not send
        // the rest of these paths to the new one.
        const workspaceId = ws.workspaceId.value;
        if (!workspaceId) return { readme: { status: "error" }, failed: [] };
        // The colour stays with the column through a rename.
        const next = columns.map((c) => (c.name === from ? { ...c, name: to } : c));
        const readme = await patchReadme(ctx, { columns: serializeColumns(next) }, workspaceId);
        const failed: string[] = [];
        if (readme.status !== "ok") return { readme, failed };
        // One CAS write per card, isolated so one conflict doesn't strand the
        // rest in a column that no longer exists; refresh once at the end. Each
        // card is re-checked as it's read: one someone moved elsewhere since the
        // board was drawn keeps its new status rather than being pulled back.
        for (const card of cards) {
          const res = await patch(
            card.path,
            (current) => {
              const status = cardStatus(current?.status);
              return status !== null && columnKey(status) === columnKey(from)
                ? { status: to }
                : null;
            },
            { refresh: false, workspaceId },
          );
          if (res.status !== "ok") failed.push(card.path);
        }
        ws.refresh();
        return { readme, failed };
      },
      // Toggled against the assignees as read for this write, not as the card
      // showed them: someone else's newer change to the list survives.
      toggleAssignee: (card, name) =>
        patch(card.path, (current) => ({
          assignee: toggledAssignee(stringList(current?.assignee), name, members.value),
        })),
    };
  }

  /** "Show as board": declare the folder a board, seeding columns from existing statuses. */
  function enableBoard(ctx: BoardContext, existingStatuses: string[]) {
    return patchReadme(ctx, boardDeclarationPatch(ctx.defaultPageFrontMatter, existingStatuses));
  }

  return { bind, enableBoard, members };
}