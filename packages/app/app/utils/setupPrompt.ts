// One-click hand-off from an un-bootstrapped workspace to whichever agent the
// user already has. Every new workspace is seeded with an AGENTS.md setup guide
// (see packages/api/server/utils/seed-content.ts); these links get an agent
// pointed at it without the user typing anything.
//
// The person clicking may have only just signed up on the web, with no desktop
// app and no synced folder yet — so the prompt cannot assume the agent can see
// the files. It does three things instead:
//   1. Explains what Treehouse is, so the agent knows what it is dealing with.
//   2. Hands over this workspace's facts (id, addresses, desktop-app link), so
//      nothing has to be asked for and a self-hosted server works too.
//   3. Points at the agent docs page that owns the procedure for getting
//      connected (/docs/agents/connect/set-up-a-workspace). The procedure lives
//      there, not here, so it can improve without shipping the app.
// Then AGENTS.md takes over.

import { buildOpenDeepLink, DESKTOP_DOWNLOAD_URL } from "./desktopApp";

/** Where the agent procedure for getting a new workspace connected lives. */
export const SETUP_DOCS_URL = "https://trytree.house/docs/agents/connect/set-up-a-workspace.md";

/** The hosted API. Anything else is a self-hosted (or staging) server. */
const HOSTED_API = "https://api.trytree.house";

/**
 * Longest prompt we put in a deep link. Claude Code's handler documents 5,000
 * characters for `q`; the others don't publish a limit, so they share the one
 * we know rather than gambling on a bigger one.
 */
const MAX_LINK_PROMPT = 5000;

export interface SetupPromptInput {
  /** The workspace's display name, so the agent can confirm it has the right one. */
  workspaceName: string;
  workspaceId: string;
  /** Origin of this web app, e.g. https://app.trytree.house */
  appOrigin: string;
  /** Base URL of this deployment's API, e.g. https://api.trytree.house */
  apiBase: string;
  /**
   * Basename of the local synced folder, when known. Only the desktop shell
   * knows this (the full path deliberately never leaves it — see
   * app/utils/desktopApp.ts), and a browser knows nothing, so this is optional.
   */
  folderName?: string | null;
}

/**
 * Build the setup prompt handed to an agent.
 *
 * This never throws. An earlier version threw when the prompt exceeded Claude
 * Code's `q` limit, which was the wrong trade: the card calls this during
 * render, so one over-long workspace name took down the whole hand-off —
 * including the Copy prompt action, the one route that is supposed to survive
 * everything else failing. The length check lives in `buildSetupLinks`, where
 * it can drop the links that cannot carry the prompt and leave the rest working.
 */
export function buildSetupPrompt(input: SetupPromptInput): string {
  const { workspaceName, workspaceId, folderName } = input;
  const appOrigin = input.appOrigin.replace(/\/+$/, "");
  const apiBase = input.apiBase.replace(/\/+$/, "");
  const desktopLink = buildOpenDeepLink({ workspaceId, appOrigin });

  const selfHosted =
    apiBase === HOSTED_API
      ? ""
      : `\nThis server isn't trytree.house: use these addresses wherever the docs show trytree.house ones, and pass --api-base ${apiBase} to the treehouse CLI.\n`;

  const whereItIs = folderName
    ? `It already syncs to a folder called "${folderName}" on this computer, so start by finding it.`
    : `It may not be on this computer yet. If it isn't, get it syncing to a folder for me.`;

  return `Help me set up my new Treehouse workspace, "${workspaceName}".

Treehouse is a shared workspace of plain files (markdown, HTML, PDFs, anything) that I, my team and our agents all work in. The Treehouse desktop app or CLI keeps it in sync with a folder on my computer, and the Treehouse web app shows the same files as pages we can read, comment on and share. You work in it like any other folder.

Workspace: ${workspaceName}
Workspace id: ${workspaceId}
Web app: ${appOrigin}
API: ${apiBase}
MCP server: ${apiBase}/api/mcp
Desktop app link: ${desktopLink}
${selfHosted}
1. Get connected. ${whereItIs} Follow ${SETUP_DOCS_URL} — it shows how to find the workspace's folder, or connect one with the desktop app or CLI. Do as much as you can yourself; I'll approve and click where I have to. If you can't open that page: on an Apple silicon Mac, install the desktop app from ${DESKTOP_DOWNLOAD_URL} and open the desktop app link; anywhere else, connect over MCP as below.
   If you can't run commands on this computer but can use MCP connectors, add the MCP server above as a remote MCP server instead: it opens my browser so I can sign in and approve you.
2. Then read AGENTS.md at the root of the workspace and follow it. It has you interview me, propose a folder structure, build it once I agree, and suggest what to set up next.

Don't create anything in the workspace until I've agreed to the structure.`;
}

export interface SetupLinks {
  /** Claude Code in the terminal. */
  claudeCode: string | null;
  /** A new Claude Cowork session in the Claude desktop app. */
  cowork: string | null;
  /** A new chat in the Codex app. */
  codex: string | null;
}

/**
 * Deep links for each target. Every one of them fills the prompt box and never
 * sends it, so a click can't set an agent running on its own.
 *
 * - `claude-cli://open?q=` is Claude Code's documented handler.
 * - `claude://cowork/new?q=` is the Claude desktop app's documented Cowork link.
 * - `codex://new?prompt=` is the Codex app's documented new-chat link.
 *
 * None carries a folder: a browser has no idea where the synced folder is (and
 * may have none yet), which is exactly what the prompt's first step handles.
 *
 * Each comes back `null` when the prompt is longer than we trust a link to
 * carry. Dropping a button is much better than offering a link that gets
 * truncated: a half-instruction reads exactly like a whole one, so the agent
 * would set off confidently having been told only part of the job.
 */
export function buildSetupLinks(prompt: string): SetupLinks {
  if (prompt.length > MAX_LINK_PROMPT) return { claudeCode: null, cowork: null, codex: null };
  const q = encodeURIComponent(prompt);
  return {
    claudeCode: `claude-cli://open?q=${q}`,
    cowork: `claude://cowork/new?q=${q}`,
    codex: `codex://new?prompt=${q}`,
  };
}

/**
 * Whether a workspace still looks un-set-up, and so should be offered the
 * hand-off. True for a workspace with no folders and at most a couple of files
 * — which covers both the seeded state (README.md + AGENTS.md) and a genuinely
 * empty workspace (seeding disabled via TREEHOUSE_SEED=0).
 *
 * Deliberately NOT "does AGENTS.md exist": the bootstrap's last step REPLACES
 * AGENTS.md with workspace-specific conventions rather than deleting it, so its
 * presence says nothing about whether setup has happened. The arrival of
 * folders does.
 *
 * Takes the built tree rather than the flat entry list because the tree already
 * drops `.keep` placeholders, which would otherwise read as real files.
 */
export function needsSetup(tree: { isDir: boolean }[]): boolean {
  return tree.length <= 2 && !tree.some((node) => node.isDir);
}