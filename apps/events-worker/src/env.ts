export interface Env {
  PLATFORM_DB?: Hyperdrive;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** Entitlement checks for notification rules (ES2). */
  BILLING_WORKER?: Fetcher;
  /** Email delivery for matched notification rules (ES2). */
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
}
