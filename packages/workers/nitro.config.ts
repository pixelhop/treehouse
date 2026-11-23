import { defineNitroConfig } from "nitropack/config";

// https://nitro.build/config
export default defineNitroConfig({
  compatibilityDate: "latest",
  srcDir: "server",
  imports: {
    autoImport: true,
  },
  runtimeConfig: {
    redisUrl: "",
    // No default: the queue dashboard stays off until both are set
    // (NITRO_BULL_BOARD_USERNAME / NITRO_BULL_BOARD_PASSWORD).
    bullBoardUsername: "",
    bullBoardPassword: "",
  },
});