// For the type-aware linter, which doesn't read Nuxt's generated tsconfig and so
// can't resolve the `.vue` imports in utils/viewers.ts. An ambient wildcard is
// only a fallback, so `nuxt typecheck` still resolves the real components.
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent;
  export default component;
}