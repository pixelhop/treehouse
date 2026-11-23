import { createError, defineEventHandler, getRequestURL, setHeader } from "h3";
import { createBasicAuth } from "../utils/basic-auth";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();

  // will only execute for /admin/queues route
  if (getRequestURL(event).pathname.startsWith("/admin/queues")) {
    // Fail closed: with no credentials configured there is nothing to check a
    // login against, so the dashboard is off rather than open to a default.
    if (!config.bullBoardUsername || !config.bullBoardPassword) {
      throw createError({
        statusCode: 503,
        message:
          "Queue dashboard is disabled: set NITRO_BULL_BOARD_USERNAME and NITRO_BULL_BOARD_PASSWORD.",
      });
    }

    const basicAuth = createBasicAuth({
      username: config.bullBoardUsername,
      password: config.bullBoardPassword,
    });

    const isAuthenticated = basicAuth.check(event);
    if (isAuthenticated) {
      return;
    }

    const authRes = basicAuth.authorize();

    // send headers
    if (authRes.headers) {
      for (const [key, value] of Object.entries(authRes.headers)) {
        setHeader(event, key, value);
      }
    }

    // check to render unauthenticated page
    if (!authRes.authorized) {
      throw createError({
        statusCode: 401,
        message: authRes.message || "Unauthorized",
      });
    }
  }
});