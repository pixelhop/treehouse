import type { Env, ExecutionContextLike } from "./env";
import { handle } from "./handler";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    return handle(request, env, ctx);
  },
};