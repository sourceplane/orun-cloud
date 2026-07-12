// Orphan-mint reconcile sweep (saas-integration-hub IH9, design §5.2).
//
// Cloudflare only in v1: minted child tokens are named
// `orun/{org}/{template}/{mintId}` provider-side, and Cloudflare exposes both
// account-token listing and deletion — so the sweep can reconcile provider
// truth against the ledger in BOTH directions. Supabase has no provider-side
// token listing or revoke for its short-lived access tokens (TTL is the only
// backstop there), so it has no orphan sweep.
//
// Per active Cloudflare account:
//   provider → ledger: a provider-side token whose name parses as ours but
//     whose ledger row is missing or no longer pending is an ORPHAN — revoke
//     it provider-side via the broker capability.
//   ledger → provider: a pending ledger mint whose providerRef is not among
//     the provider-side token ids is already gone provider-side — mark it
//     revoked (provider-side truth wins).
// Tokens whose names don't parse as ours are NEVER touched.
//
// Best-effort throughout: per-account failures are counted, never thrown.

import type { Env } from "./env.js";
import { createIntegrationHubRepository } from "@saas/db/integrations";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import type { FetchLike } from "./github-app.js";
import { createCloudflareProvider, listCloudflareAccountTokens } from "./providers/cloudflare.js";
import { getCapability } from "./providers/types.js";
import { readParentCredential } from "./custody.js";
import { parseMintedCredentialPublicId } from "./ids.js";

export interface OrphanSweepSummary {
  accounts: number;
  orphansRevoked: number;
  ledgerReconciled: number;
  failures: number;
}

/** Bounded accounts per run — the sweep is daily; stalest rows go first. */
export const ORPHAN_SWEEP_ACCOUNT_LIMIT = 25;

/** Parse a provider-side token name as one of OUR mints
 *  (`orun/{orgPublicId}/{template}/{mintPublicId}`) → the mint's row uuid.
 *  Null = not ours; the sweep must never touch it. */
function parseMintNameToUuid(name: string): string | null {
  const parts = name.split("/");
  if (parts.length !== 4 || parts[0] !== "orun") return null;
  return parseMintedCredentialPublicId(parts[3]!);
}

export async function runOrphanSweep(
  env: Env,
  executor: SqlExecutor,
  opts?: { fetchImpl?: FetchLike; now?: Date; accountLimit?: number },
): Promise<OrphanSweepSummary> {
  const summary: OrphanSweepSummary = {
    accounts: 0,
    orphansRevoked: 0,
    ledgerReconciled: 0,
    failures: 0,
  };
  const now = opts?.now ?? new Date();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const limit = opts?.accountLimit ?? ORPHAN_SWEEP_ACCOUNT_LIMIT;

  try {
    const hub = createIntegrationHubRepository(executor);
    const listed = await hub.listCloudflareAccountsForSweep(limit);
    if (!listed.ok) {
      summary.failures++;
      return summary;
    }
    const broker = getCapability(createCloudflareProvider(fetchImpl), "broker");
    if (!broker) {
      summary.failures++;
      return summary;
    }

    for (const account of listed.value) {
      // Only active connections: suspended/revoked ones are the revoke
      // fan-out's (or the health cron's) problem, not the sweep's.
      if (!account.connectionId || account.connectionStatus !== "active") continue;
      summary.accounts++;
      try {
        const connectionUuid = asUuid(account.connectionId);
        const parent = await readParentCredential(env, executor, connectionUuid, "cloudflare");
        if (!parent) {
          summary.failures++;
          continue;
        }
        const providerTokens = await listCloudflareAccountTokens(parent, fetchImpl);
        if (providerTokens === null) {
          summary.failures++;
          continue;
        }
        const live = await hub.listLiveMintedCredentials(connectionUuid);
        if (!live.ok) {
          summary.failures++;
          continue;
        }
        const liveProviderRefs = new Set(
          live.value.map((m) => m.providerRef).filter((ref): ref is string => ref !== null),
        );

        // Provider → ledger: ours-by-name with no live ledger row → orphan.
        for (const token of providerTokens) {
          const mintUuid = parseMintNameToUuid(token.name);
          if (!mintUuid) continue; // not ours — never touch it
          if (liveProviderRefs.has(token.id)) continue; // live and ledgered
          const mint = await hub.getMintedCredential(asUuid(account.orgId), asUuid(mintUuid));
          if (mint.ok && mint.value.revokeStatus === "pending") continue; // still live
          const revoked = await broker.revokeCredential(token.id, now.getTime(), parent);
          if (revoked) summary.orphansRevoked++;
          else summary.failures++;
        }

        // Ledger → provider: pending mints the provider no longer has → the
        // token is gone provider-side (provider truth) — close the ledger row.
        const providerTokenIds = new Set(providerTokens.map((t) => t.id));
        for (const mint of live.value) {
          if (mint.providerRef === null) continue; // nothing to reconcile against
          if (providerTokenIds.has(mint.providerRef)) continue;
          const marked = await hub.markMintedCredential(asUuid(mint.id), {
            revokeStatus: "revoked",
            revokedAt: now,
          });
          if (marked.ok) summary.ledgerReconciled++;
          else summary.failures++;
        }
      } catch {
        summary.failures++;
      }
    }
  } catch {
    summary.failures++;
  }
  return summary;
}
