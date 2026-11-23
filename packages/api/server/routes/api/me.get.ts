import { createError, defineEventHandler } from "h3";
import { auth } from "../../utils/auth";
import { webHeaders } from "../../utils/workspace";

// Example protected endpoint: returns the current session/user, or 401.
// Use this as the pattern for any route that requires an authenticated user.
export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: webHeaders(event) });

  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  return { user: session.user };
});