/**
 * Site-level copy shared by the agent-facing docs files (`/llms.txt`,
 * `/llms-docs.txt`). Pure data so the llms builders stay unit-testable.
 */

export const DOCS_SITE_DESCRIPTION =
  "Treehouse is a shared file workspace for people and their agents. Everything is a plain file: people use it through the web app and a synced folder on their computer, agents through the same folder, an MCP server or a REST API.";

/**
 * The facts an agent needs before it reads any page: where to connect and how
 * to authenticate. Kept short and literal; the linked pages carry the detail.
 */
export function docsAgentFacts(siteUrl: string): string {
  const origin = siteUrl.replace(/\/+$/, "");
  return `If you are an agent working in a Treehouse workspace, start with the agent handbook: ${origin}/docs/agents/handbook.md

- MCP server: https://api.trytree.house/api/mcp (Streamable HTTP). Connect with no credentials and the server's 401 starts OAuth: the person signs in and names the connection in their browser. Or send an \`x-api-key: <key>\` header; people create keys in the web app from the account menu, under Agents & API keys.
- REST API: https://api.trytree.house/api/workspaces/{workspaceId}/... with an \`x-api-key\` header (OAuth tokens are for MCP only).
- Read AGENTS.md at the workspace root before doing anything else, if it exists.
- Every file has a version. Pass the version you read when you write, so a concurrent edit becomes a conflicted copy instead of being lost.
- Every docs page is available as markdown by adding \`.md\` to its URL.
- The Treehouse agent skill: ${origin}/.well-known/agent-skills/treehouse/SKILL.md`;
}