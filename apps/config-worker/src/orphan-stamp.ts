// brokered-orphan-safety (Feature 1): stamp brokered secrets with derived
// orphan health before they leave the read path (list / get / chain), so the
// console, `orun secrets`, and plan all render the same truth.

import type { PublicSecretMetadata } from "@saas/contracts/config";
import { deriveOrphan, type BindingStatus } from "./orphan.js";
import { fetchConnectionStatuses, type ConnectionStatusesResult } from "./integrations-client.js";

/** Injected connection-status lookup (production wires fetchConnectionStatuses). */
export type ConnectionStatusLookup = (
  connectionIds: string[],
) => Promise<ConnectionStatusesResult>;

/**
 * Stamp `orphaned` / `bindingStatus` onto brokered secrets from live connection
 * health. Static secrets pass through untouched. Fail-soft: if the status
 * lookup is unreachable, brokered rows are left UNstamped (health unknown)
 * rather than being asserted orphaned. A connection absent from the returned
 * map was not found and is treated as missing (orphaned). Additive + idempotent.
 */
export async function stampOrphaned(
  secrets: PublicSecretMetadata[],
  lookup: ConnectionStatusLookup,
): Promise<PublicSecretMetadata[]> {
  const ids = [
    ...new Set(
      secrets.flatMap((s) =>
        s.source === "brokered" && s.binding?.connectionId ? [s.binding.connectionId] : [],
      ),
    ),
  ];
  if (ids.length === 0) return secrets;

  const result = await lookup(ids);
  if (!result.ok) return secrets; // unreachable — do not assert orphaned

  return secrets.map((s) => {
    if (s.source !== "brokered" || !s.binding?.connectionId) return s;
    const raw = result.statuses[s.binding.connectionId];
    const status: BindingStatus | null = raw === undefined ? null : (raw as BindingStatus);
    const v = deriveOrphan("brokered", status);
    return { ...s, bindingStatus: v.bindingStatus, orphaned: v.orphaned };
  });
}

/** Production lookup: env.INTEGRATIONS_WORKER → fetchConnectionStatuses. */
export function bindingLookup(binding: Fetcher, requestId: string): ConnectionStatusLookup {
  return (ids) => fetchConnectionStatuses(binding, ids, requestId);
}
