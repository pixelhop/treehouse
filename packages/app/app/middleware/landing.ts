// `/` is a doorway, not a page: nobody should ever see it render.
//
// A signed-in visitor drops straight back into the workspace they last had
// open — /workspace does the resolving (last opened → first in the active org
// → dashboard when they have none). Everyone else goes to sign-in, which links
// to sign-up. A failed session lookup (offline, API down) also lands on
// sign-in rather than erroring the route; sign-in surfaces the failure itself.
// Usage in a page: definePageMeta({ middleware: "landing" })
export default defineNuxtRouteMiddleware(async () => {
  try {
    const { data: session } = await useAuthClient().getSession();
    if (session) return navigateTo("/workspace", { replace: true });
  } catch {
    // fall through to sign-in
  }
  return navigateTo("/sign-in", { replace: true });
});