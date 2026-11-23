import { createError, defineEventHandler } from "h3";
import { useRuntimeConfig } from "nitropack/runtime";
import { buildDescriptor, isHttpUrl } from "../../utils/descriptor";

// GET /.well-known/treehouse — the API-origin descriptor (R15). Server-rendered
// on the app Worker so it reports this deployment's RUNTIME apiUrl (overridable
// via NUXT_PUBLIC_API_URL), letting a client that only has the app origin (e.g.
// from an invite URL) discover the API origin — self-hosted instances included.
export default defineEventHandler((event) => {
  // Guard the value, not just the type: unset, empty, unparseable, or a
  // non-http(s) scheme are all misconfigurations that must fail loudly here
  // rather than be served as a successful descriptor the client will reject as
  // "not a Treehouse server". A path-bearing apiUrl is deliberately allowed —
  // the app itself builds `${apiUrl}/api/...`, so an API mounted on a subpath
  // behind a reverse proxy is a supported self-hosted layout.
  const apiUrl = useRuntimeConfig(event).public.apiUrl;
  if (typeof apiUrl !== "string" || !isHttpUrl(apiUrl)) {
    throw createError({
      statusCode: 500,
      statusMessage: "public.apiUrl is not configured as an http(s) URL",
    });
  }
  return buildDescriptor(apiUrl);
});