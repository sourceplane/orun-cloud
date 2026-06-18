// Usage metering for the object/log plane (OP3 — design §7).
//
// "Metering records must flow from OP3 onward; the rollup wiring may stub until
// OP9." We satisfy that by writing raw `metering.usage_records` directly through
// the shared metering repository on the worker's existing PLATFORM_DB binding —
// the same table the metering-worker rolls up. No service binding is added: the
// records land at the source of truth and OP9 wires rollups/quotas over them.
//
// Emission is BEST-EFFORT and idempotent: a usage record never fails the user's
// request (a log append or object PUT succeeds even if metering is down), and a
// stable idempotency key (scoped per org) makes a replay a no-op.

import { createMeteringRepository } from "@saas/db/metering";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { generateUuid } from "./ids.js";

/** Metric keys for the state plane (design §7). */
export const STATE_METRICS = {
  LOG_BYTES: "state.log_bytes",
  OBJECT_BYTES: "state.object_bytes",
  OBJECT_COUNT: "state.object_count",
  /** Count of runs created — metered, and the over-quota gate's metric (OV9). */
  RUNS: "state.runs",
} as const;

export interface EmitUsageInput {
  executor: SqlExecutor;
  orgPublicId: string;
  projectPublicId: string;
  metric: string;
  quantity: number;
  /**
   * Stable per-scope idempotency seed (e.g. `log:{run}:{job}:{seq}` or
   * `object:{digest}`). Combined with the metric so a digest can meter both
   * bytes and count without colliding.
   */
  idempotencySeed: string;
  metadata?: Record<string, unknown>;
}

/**
 * Emit one usage record. Best-effort: any failure (binding down, conflict on a
 * replay) is swallowed so the caller's request still succeeds.
 */
export async function emitUsage(input: EmitUsageInput): Promise<void> {
  try {
    const repo = createMeteringRepository(input.executor);
    await repo.recordUsage({
      id: generateUuid(),
      orgId: input.orgPublicId,
      projectId: input.projectPublicId,
      metric: input.metric,
      quantity: input.quantity,
      idempotencyKey: `${input.metric}:${input.idempotencySeed}`,
      metadata: input.metadata ?? null,
    });
  } catch {
    // Best-effort: metering never blocks the data path.
  }
}
