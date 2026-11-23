import { defineNitroConfig } from "nitropack/config";

// https://nitro.build/config
export default defineNitroConfig({
  compatibilityDate: "latest",
  srcDir: "server",
  imports: {
    autoImport: true,
  },
  runtimeConfig: {
    logLevel: "info",
    redisUrl: "",
    public: {
      apiBase: "/api",
    },
  },
  // CORS is handled in server/middleware/cors.ts because auth needs
  // credentialed, origin-specific CORS (a wildcard origin can't carry cookies).
});