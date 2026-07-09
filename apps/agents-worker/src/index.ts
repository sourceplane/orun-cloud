// agents-worker — the agent-session control plane (saas-agents AG5–AG11).
//
// The runtime that runs an agent is the orun binary (orun/specs/orun-agents/);
// this worker HOSTS it: it provisions a sandbox, mints a session-scoped
// credential, relays the session's event stream, and dispatches. It holds no
// agent semantics, no tool policy, no task state — a client of the platform's
// public surfaces, its blast radius a service principal's.
//
// AG5 is the dormant foundation: /health only.

import type { Env } from "./env.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
} satisfies ExportedHandler<Env>;
