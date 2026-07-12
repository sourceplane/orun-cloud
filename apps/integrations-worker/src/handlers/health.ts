import type { Env } from "../env.js";
import { successResponse } from "../http.js";

export function handleHealth(env: Env, requestId: string): Response {
  const dbConfigured = !!env.PLATFORM_DB;
  const membershipConfigured = !!env.MEMBERSHIP_WORKER;
  const policyConfigured = !!env.POLICY_WORKER;
  const billingConfigured = !!env.BILLING_WORKER;
  // D1 gate: live GitHub paths stay parked until the per-environment App
  // registration provides these secrets. Presence only — never values.
  const githubAppConfigured = !!(
    env.GITHUB_APP_ID &&
    env.GITHUB_APP_PRIVATE_KEY &&
    env.GITHUB_APP_WEBHOOK_SECRET
  );
  // IH0 gates: per-provider registration secrets (IH risks D1/D3/D4).
  // Presence only — never values.
  const slackAppConfigured = !!(
    env.SLACK_APP_CLIENT_ID &&
    env.SLACK_APP_CLIENT_SECRET &&
    env.SLACK_APP_SIGNING_SECRET
  );
  const supabaseOauthConfigured = !!(
    env.SUPABASE_OAUTH_CLIENT_ID && env.SUPABASE_OAUTH_CLIENT_SECRET
  );
  // Cloudflare custody needs only the envelope key (no platform credential).
  const credentialCustodyConfigured = !!env.SECRET_ENCRYPTION_KEY;

  return successResponse(
    {
      service: "integrations-worker",
      environment: env.ENVIRONMENT ?? "local",
      checks: {
        database: { configured: dbConfigured },
        membership: { configured: membershipConfigured },
        policy: { configured: policyConfigured },
        billing: { configured: billingConfigured },
        githubApp: { configured: githubAppConfigured },
        slackApp: { configured: slackAppConfigured },
        supabaseOauth: { configured: supabaseOauthConfigured },
        credentialCustody: { configured: credentialCustodyConfigured },
      },
    },
    requestId,
  );
}
