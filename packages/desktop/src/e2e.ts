import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "cli/src/paths";
import { app, dialog } from "electron";

// The end-to-end harness seam (scripts/desktop-e2e.mjs). Onboarding is mostly a
// web page in the workspace window, which CDP can drive — but every decision point
// that matters (the folder picker, "that folder isn't empty", Retry/Cancel, the
// TOFU prompt) is a NATIVE dialog CDP cannot see. Driving those through macOS
// accessibility needs a permission grant per terminal and breaks on any layout
// change, so the harness gets a file-based mailbox instead:
//
//    <TREEHOUSE_HOME>/e2e/dialog-<n>.json         ← the app writes each dialog it would show
//    <TREEHOUSE_HOME>/e2e/dialog-<n>-answer.json  ← the harness writes the answer
//
// The app polls for the answer, so a run that forgets to answer simply waits —
// exactly like a real user who hasn't clicked yet.
//
// Only active in an UNPACKAGED run with TREEHOUSE_E2E=1. A packaged build never
// installs it, whatever its environment says: `app.isPackaged` is the same gate
// the rest of the shell uses for dev affordances.

/** Is the dialog mailbox active for this run? */
export function e2eEnabled(): boolean {
  return !app.isPackaged && process.env.TREEHOUSE_E2E === "1";
}

// One request/answer pair PER dialog: two can be open at once (a stale Retry
// prompt under a superseding flow's folder picker), and a single shared file
// would let one dialog consume the other's answer.
const mailbox = (): string => join(appDir(), "e2e");
let nextDialog = 1;
const requestPath = (id: number): string => join(mailbox(), `dialog-${id}.json`);
const answerPath = (id: number): string => join(mailbox(), `dialog-${id}-answer.json`);

/** What the harness writes back. `response` is a button index for a message box;
 * `filePaths` / `canceled` answer an open dialog. */
interface Answer {
  response?: number;
  filePaths?: string[];
  canceled?: boolean;
}

async function ask(kind: string, options: Record<string, unknown>): Promise<Answer> {
  const id = nextDialog++;
  mkdirSync(mailbox(), { recursive: true });
  rmSync(answerPath(id), { force: true });
  writeFileSync(
    requestPath(id),
    `${JSON.stringify({ id, kind, at: new Date().toISOString(), options }, null, 2)}\n`,
  );
  const label = [options.message, options.title].find((v) => typeof v === "string") ?? "";
  console.log(`[e2e] dialog ${id} waiting: ${kind} — ${label}`);
  for (;;) {
    if (existsSync(answerPath(id))) {
      try {
        const answer = JSON.parse(readFileSync(answerPath(id), "utf8")) as Answer;
        rmSync(answerPath(id), { force: true });
        rmSync(requestPath(id), { force: true });
        console.log(`[e2e] dialog ${id} answered: ${JSON.stringify(answer)}`);
        return answer;
      } catch {
        // half-written answer — read it again next tick
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The electron dialog overloads take an optional parent window first. */
function optionsArg(args: unknown[]): Record<string, unknown> {
  const last = args[args.length - 1];
  return last && typeof last === "object" ? (last as Record<string, unknown>) : {};
}

/** Route native dialogs through the mailbox. Call once, before any window opens. */
export function installE2EDialogs(): void {
  if (!e2eEnabled()) return;
  console.log(`[e2e] dialog mailbox at ${mailbox()}`);
  const d = dialog as unknown as Record<string, unknown>;
  d.showMessageBox = async (...args: unknown[]) => {
    const options = optionsArg(args);
    const a = await ask("message", options);
    return {
      response: a.response ?? (options.defaultId as number | undefined) ?? 0,
      checkboxChecked: false,
    };
  };
  d.showOpenDialog = async (...args: unknown[]) => {
    const a = await ask("open", optionsArg(args));
    return { canceled: a.canceled ?? !a.filePaths?.length, filePaths: a.filePaths ?? [] };
  };
}