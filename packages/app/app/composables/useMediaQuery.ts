// Reactive `window.matchMedia`, shared per query.
//
// The cache is module-level rather than per-call: the SPA has one app instance,
// so one listener per distinct query lives for the life of the page instead of
// one per component that asks. Callers get a plain readonly ref they can use in
// a template or a computed.
//
// Server-safe by construction (the app is `ssr: false`, but the guard keeps this
// honest if that ever changes): with no `window` it reports `false`, i.e. "no
// media query matches", which every caller here treats as the desktop default.
const cache = new Map<string, Ref<boolean>>();

export function useMediaQuery(query: string): Ref<boolean> {
  const cached = cache.get(query);
  if (cached) return cached;

  const matches = ref(false);
  if (import.meta.client) {
    const mql = window.matchMedia(query);
    matches.value = mql.matches;
    mql.addEventListener("change", (e) => {
      matches.value = e.matches;
    });
  }
  cache.set(query, matches);
  return matches;
}