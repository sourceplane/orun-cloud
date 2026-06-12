export interface Env {
  PLATFORM_DB?: Hyperdrive;
  EVENTS_WORKER?: Fetcher;
  ENVIRONMENT: string;
  /** Provider selector; only "local-debug" is wired in V1. */
  NOTIFICATIONS_PROVIDER?: string;
  DEBUG_DELIVERY?: string;
}
