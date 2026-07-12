import type { CloudflareEmailSender } from "./providers/cloudflare-email.js";

export interface Env {
  PLATFORM_DB?: Hyperdrive;
  /** Cloudflare Email Service send_email binding (cloudflare-email provider). */
  EMAIL?: CloudflareEmailSender;
  /** Authorization context for channel CRUD (ES3). */
  MEMBERSHIP_WORKER?: Fetcher;
  /** Policy decisions for channel CRUD (ES3). */
  POLICY_WORKER?: Fetcher;
  /** Entitlement checks for Slack channels (ES3). */
  BILLING_WORKER?: Fetcher;
  /**
   * slack_app delivery-credential reads (saas-integration-hub IH2): the bot
   * token is fetched per send over this binding and held in isolate memory
   * only — this worker never stores a provider credential (design §4.2).
   */
  INTEGRATIONS_WORKER?: Fetcher;
  /**
   * Hex-encoded 256-bit key for AES-256-GCM encryption of channel bearer
   * credentials (Slack incoming-webhook URLs). Set out-of-band via
   * `wrangler secret put SECRET_ENCRYPTION_KEY --env <env>`; absent locally.
   */
  SECRET_ENCRYPTION_KEY?: string;
  ENVIRONMENT: string;
  /** Provider selector: "local-debug" (default) or "cloudflare-email". */
  NOTIFICATIONS_PROVIDER?: string;
  DEBUG_DELIVERY?: string;
  /** Verified sender address for the cloudflare-email provider. */
  EMAIL_FROM_ADDRESS?: string;
  /** Optional sender display name / brand for the cloudflare-email provider. */
  EMAIL_FROM_NAME?: string;
  /**
   * Console origin used to build deep links in emails (e.g. the invitation
   * "Accept invitation" button → `${CONSOLE_BASE_URL}/invitations/accept?...`).
   * Mirrors identity-worker's `CLI_CONSOLE_BASE_URL`: local/dev
   * `http://localhost:3000`, stage `https://stage.orun.dev`, prod
   * `https://app.orun.dev`. When unset, link-bearing templates degrade to
   * their plain "sign in to view and accept" copy.
   */
  CONSOLE_BASE_URL?: string;
}
