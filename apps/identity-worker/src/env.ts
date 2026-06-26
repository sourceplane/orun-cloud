export interface Env {
  PLATFORM_DB?: Hyperdrive;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
  DEBUG_DELIVERY: string;

  // --- OAuth sign-in (B1) ---
  // Non-secret vars live in wrangler.jsonc; secrets are set via
  // `wrangler secret put`. A provider is "enabled" only when its client
  // credentials AND the shared runtime config (state secret + redirect base)
  // are all present — otherwise the console shows no button and `start` 400s.

  /** GitHub OAuth App client id (non-secret config). */
  GITHUB_OAUTH_CLIENT_ID?: string;
  /** GitHub OAuth App client secret (secret). */
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** Google OAuth 2.0 client id (non-secret config). */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  /** Google OAuth 2.0 client secret (secret). */
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** HMAC signing secret for the stateless OAuth `state` token (secret). */
  OAUTH_STATE_SECRET?: string;
  /** Public api-edge origin fronting this worker; used to build the provider
   *  redirect_uri (must match the OAuth app's registered callback). */
  OAUTH_REDIRECT_BASE_URL?: string;
  /** Comma-separated console origins allowed as post-login redirect targets. */
  OAUTH_ALLOWED_CONSOLE_ORIGINS?: string;

  // --- CLI session auth (OP1) ---
  /**
   * HS256 signing key for the CLI access-token JWT (~15 min). Managed via
   * secrets-sync: it lives in the `platform-secrets/<env>` document
   * (`tooling/secrets-sync/integrations.manifest.json`) and the deploy lane's
   * `secrets-live` step pushes it to this worker — do NOT `wrangler secret put`
   * it by hand. OPTIONAL at boot — the worker only fails when it actually
   * mints/verifies a CLI token, so a missing secret never breaks the deploy
   * verify. Value is ≥32 chars.
   */
  CLI_JWT_SIGNING_KEY?: string;
  /**
   * Public base URL of the web console, used to build the CLI approval page
   * `authorizeUrl` (e.g. https://app.orun.dev). Falls back to the first
   * OAUTH_ALLOWED_CONSOLE_ORIGINS entry when unset.
   */
  CLI_CONSOLE_BASE_URL?: string;
}
