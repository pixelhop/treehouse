import { needsFullLoad } from "~/utils/landing";

// Comparison pages and guides are prerendered, and their content exists only at
// build time: there is no content database on the Worker or in the browser. So
// arriving at one by client-side navigation (from the SPA homepage, or from
// another of these pages) has nothing to render. Make it a real page load, which
// serves the prerendered HTML. The docs avoid this with payload files; these
// pages link in from the SPA, which can't know those exist.
export default defineNuxtRouteMiddleware((to, from) => {
  if (import.meta.client && !useNuxtApp().isHydrating && needsFullLoad(to.path, from.path)) {
    return navigateTo(to.fullPath, { external: true });
  }
});