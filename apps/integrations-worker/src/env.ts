export interface Env {
  PLATFORM_DB?: Hyperdrive;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  PROJECTS_WORKER?: Fetcher;
  ENVIRONMENT: string;

  // ── Per-environment secrets (wrangler secret put; never vars) ──
  // All optional until the GitHub App is registered for the environment
  // (saas-integrations risks-and-open-questions.md D1). The worker stays
  // dormant — health-only — while they are unset.

  /** Hex-encoded 256-bit key for installation-token-cache encryption (AES-256-GCM). */
  SECRET_ENCRYPTION_KEY?: string;
  /** HMAC key for the signed single-use connect-flow state. */
  INTEGRATIONS_STATE_SECRET?: string;
  /** GitHub App identity (per environment). */
  GITHUB_APP_ID?: string;
  /** PEM-encoded RS256 private key for App JWT minting. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** HMAC secret GitHub signs inbound webhook deliveries with. */
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  /** GitHub App slug, used to build the public install URL. */
  GITHUB_APP_SLUG?: string;

  /**
   * Public origin of api-edge for this environment (plain var, not a secret;
   * same convention as identity-worker). OAuth-kind connect flows build their
   * redirect_uri from it: `{base}/ingress/slack/oauth` (IH1). Unset = the
   * oauth connect surface parks with a typed 412.
   */
  OAUTH_REDIRECT_BASE_URL?: string;

  /**
   * Console origin for deep links in Slack responses (IH3 `/orun`,
   * notification actions) — metadata-only links into the console, where real
   * RBAC applies. Same convention as notifications-worker's CONSOLE_BASE_URL.
   */
  CONSOLE_BASE_URL?: string;

  // ── saas-integration-hub provider credentials (IH0; all optional) ──
  // Slack App per environment (IH risks D1). Dormant until set.
  SLACK_APP_CLIENT_ID?: string;
  SLACK_APP_CLIENT_SECRET?: string;
  /** Signing secret Slack signs inbound requests with (v0 scheme). */
  SLACK_APP_SIGNING_SECRET?: string;
  // Supabase OAuth app per environment (IH risks D4). Dormant until set.
  SUPABASE_OAUTH_CLIENT_ID?: string;
  SUPABASE_OAUTH_CLIENT_SECRET?: string;
  // Cloudflare OAuth client per environment (IH risks D3 — Cloudflare shipped
  // OAuth clients for the API). When both are set the Cloudflare connect
  // posture upgrades from token-paste to OAuth 2 (PKCE), exactly like Supabase;
  // the durable custody credential becomes the OAuth refresh token. Unset =
  // the adapter falls back to token-paste (custody still uses
  // SECRET_ENCRYPTION_KEY above).
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  // Whitespace-separated OAuth scope list requested at the Cloudflare consent
  // screen. Cloudflare rejects a scope-less authorize request ("unexpected
  // error during authorization") and only returns a refresh token when
  // `offline_access` is requested — the adapter always appends it. Unset = the
  // adapter's minimal mint-only default. Must be a subset of the scopes the
  // OAuth client was registered with.
  CLOUDFLARE_OAUTH_SCOPE?: string;
}
