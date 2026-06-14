// Run-coordination tunables (OP2). Centralized so the wire contract, the sweep
// cron, and the client all agree on one set of numbers. The server returns the
// lease + heartbeat values on every claim so the CLI never hardcodes them
// (state-api-contract §2.2).

/** Lease window granted on claim / extended on heartbeat, in seconds. */
export const LEASE_SECONDS = 60;

/** How often the client should heartbeat, in seconds (< LEASE_SECONDS). */
export const HEARTBEAT_INTERVAL_SECONDS = 20;

/**
 * Max attempts before the sweep gives up and marks a job `timed_out`. A job
 * starts at attempt 1; each re-queue increments. With the default the sweep
 * re-queues up to attempt 5, then times out.
 */
export const MAX_JOB_ATTEMPTS = 5;

/** Upper bound on rows acted on per sweep pass (keeps a pass bounded). */
export const SWEEP_BATCH_LIMIT = 200;

/** Default page size for list endpoints. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Max page size a client may request. */
export const MAX_PAGE_LIMIT = 100;
