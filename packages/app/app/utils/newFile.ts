// Naming rules for files created from the UI. Typing a bare name ("notes") is
// the common case, so an extension-less name becomes markdown — but any explicit
// extension (including a dotfile like `.env`) is left exactly as typed.
const HAS_EXTENSION = /\.[^./\\]+$/;

/**
 * Normalize a typed file name: trim, drop trailing dots (so "notes." doesn't
 * become "notes..md"), and append `.<ext>` when no extension was given. Returns
 * "" for a name that is empty once trimmed, so callers can reject it.
 */
export function withDefaultExtension(name: string, ext = "md"): string {
  const trimmed = name.trim().replace(/\.+$/, "");
  if (!trimmed) return "";
  return HAS_EXTENSION.test(trimmed) ? trimmed : `${trimmed}.${ext}`;
}