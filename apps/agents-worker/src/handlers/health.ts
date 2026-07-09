import type { Env } from "../env.js";
import { successResponse } from "../http.js";

/** GET /health — reports which bindings are configured. AG5 is dormant, so an
 *  unwired worker still returns 200; AG6 flips `database` to configured. */
export function handleHealth(env: Env, requestId: string): Response {
  return successResponse(
    {
      service: "agents-worker",
      environment: env.ENVIRONMENT ?? "local",
      checks: {
        database: { configured: !!env.PLATFORM_DB },
        membership: { configured: !!env.MEMBERSHIP_WORKER },
        policy: { configured: !!env.POLICY_WORKER },
      },
    },
    requestId,
  );
}
