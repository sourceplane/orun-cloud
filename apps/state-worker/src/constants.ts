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

/** Upper bound on scm.* events drained into state.triggers per cron pass. */
export const SCM_DRAIN_BATCH_LIMIT = 200;

/**
 * Upper bound on terminal run events drained per cron pass by the write-back
 * driver. Smaller than the scm drain: each event is an outbound GitHub POST, so
 * a tighter batch keeps the cron tick (and GitHub call volume) bounded.
 */
export const RUN_WRITEBACK_BATCH_LIMIT = 50;

/** Default page size for list endpoints. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Max page size a client may request. */
export const MAX_PAGE_LIMIT = 100;

// ── Object & log plane budgets (OP3 — state-api-contract §2.3, §3) ──
// Centralized so the wire contract, the chunked-upload sub-protocol, and the
// client all agree on one set of numbers.

const MIB = 1024 * 1024;

/**
 * Single-request object PUT budget (state-api-contract §3). Bodies up to this
 * size go through the one-shot `PUT …/objects/{digest}`; larger blobs MUST use
 * the chunked-upload sub-protocol (`…/objects/{digest}/uploads`). Default 25 MiB.
 */
export const OBJECT_SINGLE_REQUEST_MAX_BYTES = 25 * MIB;

/**
 * Multipart part size the server advertises on upload start. R2 requires every
 * part except the last to be ≥ 5 MiB; 25 MiB keeps a 100 MiB blob to four parts.
 */
export const OBJECT_MULTIPART_PART_SIZE_BYTES = 25 * MIB;

/** Upper bound on a single multipart part body (one part-size + slack guard). */
export const OBJECT_MULTIPART_PART_MAX_BYTES = 50 * MIB;

/** Max part number a client may upload (R2 caps multipart at 10,000 parts). */
export const OBJECT_MULTIPART_MAX_PARTS = 10000;

/** Per-chunk log append budget (state-api-contract §2.3): chunks ≤ 1 MiB. */
export const LOG_CHUNK_MAX_BYTES = MIB;

/** Max chunks an assembled log read returns in one page (bounds read cost). */
export const LOG_READ_MAX_CHUNKS = 512;
