// A global registry of "does this surface hold unsaved work?" probes.
//
// The service-worker update flow (plugins/pwa.client.ts) must never reload the
// page over an unsaved edit: the reload discards the in-memory buffer, and the
// editor's beforeunload confirm only offers the user a chance to lose it
// knowingly. Each editing surface registers a probe here; the updater asks the
// registry instead of reaching into any component's state.
//
// Probes are functions, not refs, so this stays framework-free and testable.

const probes = new Set<() => boolean>();

/**
 * Register a probe reporting whether its surface currently holds unsaved work.
 * Returns the deregistration function; callers tie it to their own lifecycle
 * (e.g. `onScopeDispose`).
 */
export function registerUnsavedWork(isDirty: () => boolean): () => void {
  probes.add(isDirty);
  return () => probes.delete(isDirty);
}

/**
 * Whether any registered surface holds unsaved work. A throwing probe counts
 * as dirty: the caller is about to discard page state, and a probe that cannot
 * answer must not be read as permission.
 */
export function hasUnsavedWork(): boolean {
  for (const probe of probes) {
    try {
      if (probe()) return true;
    } catch {
      return true;
    }
  }
  return false;
}