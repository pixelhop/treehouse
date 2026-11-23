import { createError, defineEventHandler, readBody } from "h3";
import { planSlugFromSubscription } from "../../../utils/billing";
import { createWorkspaceWithOrg, requireCookieUser } from "../../../utils/workspace";
import { assertSettableIcon } from "../../../utils/workspaceIcon";

const MAX_NAME = 100;

// Create a workspace. The caller becomes its owner and its only member — a
// workspace carries its own member list (implemented as a hidden 1:1
// organization), so creating one never grants anybody else access. Cookie
// session only.
export default defineEventHandler(async (event) => {
  const ctx = await requireCookieUser(event);
  const raw = (await readBody(event)) as {
    name?: unknown;
    icon?: unknown;
    color?: unknown;
    plan?: unknown;
  } | null;
  const body = raw && typeof raw === "object" ? raw : {};

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw createError({ statusCode: 400, statusMessage: "Name is required" });
  if (name.length > MAX_NAME)
    throw createError({ statusCode: 400, statusMessage: `Name too long (max ${MAX_NAME})` });

  // A workspace that does not exist yet can't own uploaded bytes: the icon is
  // uploaded to POST /icon right after creation.
  const icon = typeof body.icon === "string" && body.icon ? body.icon : null;
  assertSettableIcon(icon, null);

  // An optional paid tier the caller intends to buy for this workspace. It does
  // not grant the plan — the workspace is created awaiting payment and the
  // client sends the user straight to checkout for it.
  //
  // This exists so that buying a SECOND workspace does not require upgrading the
  // first. Someone with a free personal workspace who wants a paid one for work
  // was previously offered only "upgrade this one", which would have started
  // charging them for their personal files.
  const plan = typeof body.plan === "string" ? planSlugFromSubscription(body.plan) : null;
  if (typeof body.plan === "string" && body.plan && !plan) {
    throw createError({ statusCode: 400, statusMessage: "Unknown plan" });
  }

  const created = await createWorkspaceWithOrg({
    userId: ctx.userId,
    name,
    icon,
    color: typeof body.color === "string" && body.color ? body.color : null,
    intendsToPay: plan != null,
  });
  return {
    id: created.id,
    name: created.name,
    icon: created.icon,
    color: created.color,
    theme: created.theme,
    themeCss: created.themeCss,
  };
});