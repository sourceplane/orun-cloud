import type { Env } from "../env.js";
import { successResponse } from "../http.js";

export function handleHealth(env: Env, requestId: string): Response {
  const dbConfigured = !!env.PLATFORM_DB;
  const objectStoreConfigured = !!env.ORUN_STATE;
  const membershipConfigured = !!env.MEMBERSHIP_WORKER;
  const policyConfigured = !!env.POLICY_WORKER;
  const projectsConfigured = !!env.PROJECTS_WORKER;

  return successResponse(
    {
      service: "state-worker",
      environment: env.ENVIRONMENT ?? "local",
      checks: {
        database: { configured: dbConfigured },
        objectStore: { configured: objectStoreConfigured },
        membership: { configured: membershipConfigured },
        policy: { configured: policyConfigured },
        projects: { configured: projectsConfigured },
      },
    },
    requestId,
  );
}
