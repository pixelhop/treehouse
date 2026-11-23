import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";
import { describe, expect, it } from "vite-plus/test";

// Every request URL the Worker sees carries a grant (a bearer capability for
// one blob), so nothing may record request URLs: invocation logs and traces
// stay off in every environment, read the way wrangler itself reads the file.

const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

describe("blob worker config never logs grant URLs", () => {
  it.each(["", "staging"])("environment %j has invocation logs and traces off", (env) => {
    const config = unstable_readConfig({ config: CONFIG, env: env || undefined });
    expect(config.observability?.logs?.invocation_logs).toBe(false);
    expect(config.observability?.traces?.enabled).toBe(false);
  });
});