import { createError, defineEventHandler, getRequestHeader, toWebRequest } from "h3";
import { auth } from "../../../utils/auth";

// Mounts the full better-auth request surface under /api/auth/* (sign-in,
// sign-up, social callbacks, organization endpoints, ...).
//
// Browser sessions only. `enableSessionForAPIKeys` lets a key read as a session,
// so without this a key could call better-auth's own api-key/create or
// api-key/update, and a read-only key would mint itself an unlimited one.
export default defineEventHandler((event) => {
  if (getRequestHeader(event, "x-api-key")) {
    throw createError({ statusCode: 403, statusMessage: "This needs a logged-in session" });
  }
  return auth.handler(toWebRequest(event));
});