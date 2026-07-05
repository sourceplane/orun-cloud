import type { CloudflareEmailSender } from "./providers/cloudflare-email.js";

export interface Env {
  PLATFORM_DB?: Hyperdrive;
  /** Cloudflare Email Service send_email binding (cloudflare-email provider). */
  EMAIL?: CloudflareEmailSender;
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
