import { basename, dirname, join } from "node:path";
import { dialog } from "electron";

// Asking where a synced folder should move to.
//
// Shared by the menubar and the bridge so the two cannot drift into asking the
// question differently — the answer determines where a user's files end up.
//
// A SAVE dialog was the first attempt, because it returns an unambiguous new
// path. It reads wrong: a save sheet with a filename field is the UI for writing
// a document, not for saying where a folder should live, and it puts the burden
// of retyping the folder's name on the user.
//
// An open-directory dialog is the familiar "choose a location" gesture, and the
// ambiguity it introduces — did they mean "become this folder" or "go inside
// it"? — is settled by convention rather than by guessing: the chosen directory
// is the PARENT, and the folder keeps its name inside it. That matches what
// "choose where to keep Acme" means to a person, and it is what every sync client
// does.

/**
 * Ask for the folder's new location. Returns the new root path, or null if the
 * user cancelled.
 *
 * `currentRoot`'s basename is preserved: moving "Acme" to ~/Work produces
 * ~/Work/Acme, never ~/Work. A destination that already exists and is occupied is
 * refused downstream by `planRelocation`, with a message naming it.
 */
export async function promptForNewLocation(currentRoot: string): Promise<string | null> {
  const name = basename(currentRoot);
  const { canceled, filePaths } = await dialog.showOpenDialog({
    // Start where the folder lives now. Without a `defaultPath`, Electron 43+
    // opens every file dialog in ~/Downloads (it used to let macOS reopen the
    // last-used directory), which is the least likely home for a synced folder.
    defaultPath: dirname(currentRoot),
    title: "Choose a location",
    message: `Choose where to keep “${name}”`,
    buttonLabel: "Move Here",
    properties: ["openDirectory", "createDirectory"],
  });
  const parent = filePaths[0];
  if (canceled || !parent) return null;
  return join(parent, name);
}