import type { Env } from "../env.js";
import type { FetchLike } from "../github-app.js";
import { createCloudflareProvider } from "./cloudflare.js";
import { createGithubProvider } from "./github.js";
import { createSlackProvider } from "./slack.js";
import { createSupabaseProvider } from "./supabase.js";
import type { IntegrationProvider } from "./types.js";

export interface ConfiguredIntegrationProvider {
  provider: IntegrationProvider;
}

/**
 * Resolve a provider adapter from per-environment credentials. Null when the
 * provider id is unknown OR its credential set is incomplete (the provider's
 * registration gate — IG D1, IH D1/D3/D4 — not done for this environment).
 * Callers park the live path with a safe error.
 */
export function getConfiguredProvider(
  env: Env,
  providerId: string,
  fetchImpl?: FetchLike,
): ConfiguredIntegrationProvider | null {
  switch (providerId) {
    case "github": {
      const appId = env.GITHUB_APP_ID;
      const appSlug = env.GITHUB_APP_SLUG;
      const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
      const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET;
      if (!appId || !appSlug || !privateKeyPem || !webhookSecret) return null;
      return {
        provider: createGithubProvider(
          { appId, appSlug, privateKeyPem, webhookSecret },
          fetchImpl,
        ),
      };
    }
    case "slack": {
      // IH risks D1: one Slack App per environment. The connect flow (IH1)
      // parks with a typed 412 until the three secrets exist.
      const clientId = env.SLACK_APP_CLIENT_ID;
      const clientSecret = env.SLACK_APP_CLIENT_SECRET;
      const signingSecret = env.SLACK_APP_SIGNING_SECRET;
      if (!clientId || !clientSecret || !signingSecret) return null;
      return {
        provider: createSlackProvider({ clientId, clientSecret, signingSecret }, fetchImpl),
      };
    }
    case "cloudflare": {
      // No platform credential exists for Cloudflare (the customer's pasted
      // parent token is the only credential — risks D3). Custody requires the
      // envelope key; the adapter stays dormant without it.
      if (!env.SECRET_ENCRYPTION_KEY) return null;
      return { provider: createCloudflareProvider() };
    }
    case "supabase": {
      // IH risks D4: one Supabase OAuth app per environment.
      const clientId = env.SUPABASE_OAUTH_CLIENT_ID;
      const clientSecret = env.SUPABASE_OAUTH_CLIENT_SECRET;
      if (!clientId || !clientSecret) return null;
      return { provider: createSupabaseProvider() };
    }
    default:
      return null;
  }
}

/** Provider ids the registry knows about (marketplace cards, validation). */
export const KNOWN_PROVIDER_IDS = ["github", "slack", "cloudflare", "supabase"] as const;
