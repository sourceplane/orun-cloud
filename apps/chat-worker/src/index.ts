// chat-worker — the Workspace Agent plane (saas-agents-native AN4). The
// durable conversational orchestrator lives here, deliberately UNPRIVILEGED:
// conversation and tool ROUTING on Cloudflare, execution never (the amended
// AG lock, design §10). One DO per chat thread; one registry DO per
// workspace; deny-by-default authz on every route.

import type { Env } from "./env.js";
import { route } from "./router.js";

export { WorkspaceAgent } from "./workspace-agent.js";
export { ChatIndex } from "./chat-index.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
} satisfies ExportedHandler<Env>;
