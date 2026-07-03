import type { Env } from "./env.js";
import { route } from "./router.js";

// Redeploy marker: forces `policy-worker` into the change-scoped deploy set so
// the bundled `@saas/policy-engine` is republished with the current permission
// catalog (the `team.*` actions from saas-teams TM4a). No behavioural change.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
} satisfies ExportedHandler<Env>;
