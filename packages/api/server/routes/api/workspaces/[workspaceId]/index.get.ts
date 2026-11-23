import { defineEventHandler } from "h3";
import { anyWriteRefusal } from "../../../../utils/acl";
import { requireWorkspaceFromRoute } from "../../../../utils/workspace";

// Metadata for one workspace (name + display icon/colour). Authorized to any
// member of the workspace's org, or an API key scoped to it. Also says what the
// caller's own access is.
export default defineEventHandler(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  return {
    id: ws.id,
    name: ws.name,
    icon: ws.icon,
    color: ws.color,
    theme: ws.theme,
    themeCss: ws.themeCss,
    // What the caller may do here, so the app can hide write controls up front
    // (the server enforces regardless).
    access: {
      role: access.role,
      canWrite: anyWriteRefusal(access) === null,
      key: access.keyScope ?? null,
    },
  };
});