import type { LandingPage } from "~/utils/landing";

/**
 * Load the comparison page or guide at the current URL. Runs at prerender, and
 * the result ships in the page. Nothing queries content on the Worker or in the
 * browser (see middleware/landing-full-load.global.ts).
 */
export async function useLandingPage() {
  const path = useRoute().path.replace(/\/+$/, "");
  const { data } = await useAsyncData(`landing.${path}`, () =>
    queryCollection("pages").path(path).first(),
  );
  if (!data.value) {
    throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
  }

  const doc = data.value;
  return {
    doc: doc as unknown as Record<string, unknown>,
    page: { ...(doc as unknown as LandingPage), path },
  };
}