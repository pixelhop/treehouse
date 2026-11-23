import { usePrismaClient } from "db";

// A workspace's members, as the app and agents see them: name, avatar and role.
// Email is deliberately omitted — no surface needs it, and returning every
// member's email to any member or key is needless exposure.
//
// "Member of a workspace" is implemented as membership of the workspace's
// hidden 1:1 organization; organizations are never shown to users.
export interface WorkspaceMemberView {
  id: string;
  name: string;
  image: string | null;
  role: string;
}

export async function listWorkspaceMembers(organizationId: string): Promise<WorkspaceMemberView[]> {
  const db = usePrismaClient();
  const members = await db.member.findMany({
    where: { organizationId },
    include: { user: { select: { id: true, name: true, image: true } } },
    orderBy: { createdAt: "asc" },
  });
  return members.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    image: m.user.image,
    role: m.role,
  }));
}

/** Members by workspace id (for callers holding only the id, like the MCP server). */
export async function listMembersOfWorkspace(workspaceId: string): Promise<WorkspaceMemberView[]> {
  const ws = await usePrismaClient().workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  return ws ? listWorkspaceMembers(ws.organizationId) : [];
}

/** Who is in a workspace right now, for telling a live grant from a stale one. */
export async function memberIdsOf(organizationId: string): Promise<Set<string>> {
  const rows = await usePrismaClient().member.findMany({
    where: { organizationId },
    select: { userId: true },
  });
  return new Set(rows.map((m) => m.userId));
}