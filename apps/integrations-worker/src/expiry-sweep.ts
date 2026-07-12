// Minted-credential expiry sweep (saas-integration-hub IH9, design §5.1:
// "TTL is the backstop"). Flips past-due `pending` ledger rows to `expired`
// in one bounded bulk statement — the ledger's truth converges even when a
// worker missed a revoke or a caller never released. Coalesced into the
// integrations-worker cron as a phase; best-effort, never throws.

import { createIntegrationHubRepository } from "@saas/db/integrations";
import type { SqlExecutor } from "@saas/db/hyperdrive";

export interface ExpirySweepSummary {
  expired: number;
}

/** Bounded batch per tick — the sweep runs every minute, backlog drains fast. */
export const EXPIRY_SWEEP_LIMIT = 500;

export async function runExpirySweep(
  executor: SqlExecutor,
  opts?: { now?: Date; limit?: number },
): Promise<ExpirySweepSummary> {
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? EXPIRY_SWEEP_LIMIT;
  try {
    const result = await createIntegrationHubRepository(executor).bulkExpireMintedCredentials(
      now,
      limit,
    );
    return { expired: result.ok ? result.value : 0 };
  } catch {
    // A sweep failure must never break the other cron phases.
    return { expired: 0 };
  }
}
