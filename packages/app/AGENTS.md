# Frontend guidelines

- Use Vue 3 with `<script setup lang="ts">` sections and keep the order `script -> template -> style`.
- Tailwind CSS is available globally; prefer utility classes over custom CSS whenever possible.
- Auth is **better-auth**. Use the `useAuthClient()` composable (`app/composables/useAuthClient.ts`) — never instantiate a second client. Gate protected pages with `definePageMeta({ middleware: "auth" })` (`app/middleware/auth.ts`).
- All cross-origin requests to the API must send credentials (the auth client already sets `credentials: "include"`); the session cookie depends on it.
- Keep the default layout lightweight. Add UI frameworks only when the project requires them and document the choice in this file.
- Use Nuxt auto-imports (`~/composables`, `~/utils`, etc.) instead of manual import barrels where possible.
- When interacting with the API from pages or components, prefer `$fetch` or dedicated composables for data fetching.
- The deploy target is **Cloudflare Workers** (`cloudflare_module` preset + `wrangler.jsonc`). Avoid Node-only APIs that aren't covered by `nodejs_compat`.
- Before opening a PR, run `vp check` (or `pnpm run build` inside `packages/app`).