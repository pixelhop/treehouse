declare module "virtual:treehouse-snippets" {
  /** Build-time Shiki output; see build/snippets.ts. */
  const snippets: Record<
    keyof (typeof import("../../build/snippets"))["snippets"],
    { label: string; html: string }
  >;
  export default snippets;
}