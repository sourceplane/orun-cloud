// Cloudflare connection-health cron (saas-integration-hub IH9, design §5.2).
//
// Per active Cloudflare connection: re-verify the pasted parent token
// (`GET /user/tokens/verify` via custody decrypt), then converge the
// `cloudflare_accounts` facts row:
//   invalid (unverifiable, non-active, or custody missing) → token_status
//     "invalid" + connection suspended + `integration.suspended` event with
//     reason "parent_token_invalid" — the console's re-auth CTA rides this;
//   expiring (parent expires_on within 14 days) → token_status "expiring";
//   healthy → token_status "active" + best-effort granted-policies refresh
//     (rendered in the console so the customer sees what they handed over).
// Best-effort throughout: per-row failures are counted, never thrown.

import type { Env } from "./env.js";
import { INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import {
  createIntegrationHubRepository,
  createIntegrationsRepository,
  type CloudflareAccount,
  type CloudflareTokenStatus,
} from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import type { FetchLike } from "./github-app.js";
import {
  getCloudflareTokenPolicies,
  refreshCloudflareAccess,
  verifyCloudflareParentToken,
} from "./providers/cloudflare.js";
import { readParentCredential, reEnvelopeParentCredential } from "./custody.js";
import { generateRequestId, generateUuid, orgPublicId } from "./ids.js";

export interface CloudflareHealthSummary {
  checked: number;
  invalid: number;
  expiring: number;
  failures: number;
}

/** Bounded accounts per run — hourly cadence; stalest rows go first. */
export const CLOUDFLARE_HEALTH_LIMIT = 50;

/** Parent `expires_on` within this window flags the connection `expiring`
 *  (design §5.2) → connection health badge + ES-routed notification. */
export const PARENT_EXPIRING_WINDOW_DAYS = 14;

type SweepRow = CloudflareAccount & { orgId: string; connectionStatus: string };

/** Facts upsert that PRESERVES the row's connect-time anchors, overriding
 *  only the health fields the cron owns. */
function factsUpsert(
  row: SweepRow,
  health: {
    tokenStatus: CloudflareTokenStatus;
    parentExpiresAt: Date | null;
    grantedPolicies?: unknown[] | null;
  },
) {
  return {
    id: row.id,
    connectionId: asUuid(row.connectionId!),
    accountExternalId: row.accountExternalId,
    accountName: row.accountName,
    parentTokenRef: row.parentTokenRef,
    grantedPolicies: health.grantedPolicies !== undefined ? health.grantedPolicies : row.grantedPolicies,
    tokenStatus: health.tokenStatus,
    parentExpiresAt: health.parentExpiresAt,
  };
}

export async function runCloudflareHealth(
  env: Env,
  executor: SqlExecutor,
  opts?: { fetchImpl?: FetchLike; now?: Date; limit?: number },
): Promise<CloudflareHealthSummary> {
  const summary: CloudflareHealthSummary = { checked: 0, invalid: 0, expiring: 0, failures: 0 };
  const now = opts?.now ?? new Date();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const limit = opts?.limit ?? CLOUDFLARE_HEALTH_LIMIT;

  try {
    const hub = createIntegrationHubRepository(executor);
    const integrations = createIntegrationsRepository(executor);
    const events = createEventsRepository(executor);
    const listed = await hub.listCloudflareAccountsForSweep(limit);
    if (!listed.ok) {
      summary.failures++;
      return summary;
    }

    for (const row of listed.value) {
      if (!row.connectionId || row.connectionStatus !== "active") continue;
      summary.checked++;
      try {
        const connectionUuid = asUuid(row.connectionId);
        const parent = await readParentCredential(env, executor, connectionUuid, "cloudflare");

        // OAuth posture (cloudflare_refresh_token): refresh-liveness, mirroring
        // the Supabase health cron — a refused refresh means the grant was
        // revoked provider-side. There is no `/user/tokens/verify` path for a
        // refresh token, and no parent expiry to surface.
        if (parent && parent.kind === "cloudflare_refresh_token") {
          const oauth =
            env.CLOUDFLARE_OAUTH_CLIENT_ID && env.CLOUDFLARE_OAUTH_CLIENT_SECRET
              ? {
                  clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
                  clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
                }
              : null;
          if (!oauth) {
            // Custody says OAuth but the env lost the client — OUR problem, not
            // evidence the grant died. Count a failure, don't suspend.
            summary.failures++;
            continue;
          }
          const grant = await refreshCloudflareAccess(oauth, parent.credential, fetchImpl);
          if (!grant) {
            const upserted = await hub.upsertCloudflareAccount(
              factsUpsert(row, { tokenStatus: "invalid", parentExpiresAt: null }),
            );
            const suspended = await integrations.updateConnectionStatus(
              asUuid(row.orgId),
              connectionUuid,
              "suspended",
            );
            const emitted = await events.appendEventWithAudit({
              event: {
                id: generateUuid(),
                type: INTEGRATION_EVENT_TYPES.SUSPENDED,
                version: 1,
                source: "integrations-worker",
                occurredAt: now,
                actorType: "system",
                actorId: "integrations-worker",
                orgId: row.orgId,
                subjectKind: "integration_connection",
                subjectId: row.connectionId,
                subjectName: null,
                requestId: generateRequestId(),
                payload: {
                  provider: "cloudflare",
                  orgId: orgPublicId(row.orgId),
                  reason: "refresh_failed",
                },
              },
              audit: {
                id: generateUuid(),
                category: "integrations",
                description:
                  "Cloudflare OAuth refresh token refused provider-side — connection suspended (re-auth required)",
              },
            });
            summary.invalid++;
            if (!upserted.ok || !suspended.ok || !emitted.ok) summary.failures++;
            continue;
          }
          // The refresh MAY have rotated the parent — re-envelope FIRST, before
          // any other call can fail (a dropped rotation strands the connection).
          if (grant.refreshToken !== parent.credential) {
            const reEnveloped = await reEnvelopeParentCredential(
              env,
              executor,
              connectionUuid,
              "cloudflare_refresh_token",
              grant.refreshToken,
              parent.externalRef,
            );
            if (!reEnveloped) {
              summary.failures++;
              continue;
            }
          }
          const upserted = await hub.upsertCloudflareAccount(
            factsUpsert(row, { tokenStatus: "active", parentExpiresAt: null }),
          );
          if (!upserted.ok) summary.failures++;
          continue;
        }

        // Token-paste posture: missing/unreadable custody or an unverifiable /
        // non-active token means the parent is dead — nothing can be minted
        // from this connection.
        const verified = parent ? await verifyCloudflareParentToken(parent.credential, fetchImpl) : null;
        if (!verified || verified.status !== "active") {
          const upserted = await hub.upsertCloudflareAccount(
            factsUpsert(row, { tokenStatus: "invalid", parentExpiresAt: row.parentExpiresAt }),
          );
          const suspended = await integrations.updateConnectionStatus(
            asUuid(row.orgId),
            connectionUuid,
            "suspended",
          );
          // Mirrors the GitHub lifecycle-suspend emission (drain.ts): the
          // console's re-auth CTA rides the reason in this payload.
          const emitted = await events.appendEventWithAudit({
            event: {
              id: generateUuid(),
              type: INTEGRATION_EVENT_TYPES.SUSPENDED,
              version: 1,
              source: "integrations-worker",
              occurredAt: now,
              actorType: "system",
              actorId: "integrations-worker",
              orgId: row.orgId,
              subjectKind: "integration_connection",
              subjectId: row.connectionId,
              subjectName: null,
              requestId: generateRequestId(),
              payload: {
                provider: "cloudflare",
                orgId: orgPublicId(row.orgId),
                reason: "parent_token_invalid",
              },
            },
            audit: {
              id: generateUuid(),
              category: "integrations",
              description:
                "Cloudflare parent token failed verification — connection suspended (re-paste required)",
            },
          });
          summary.invalid++;
          if (!upserted.ok || !suspended.ok || !emitted.ok) summary.failures++;
          continue;
        }

        const parentExpiresAt = verified.expiresOn ? new Date(verified.expiresOn) : null;
        const expiring =
          parentExpiresAt !== null &&
          parentExpiresAt.getTime() - now.getTime() <=
            PARENT_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        if (expiring) {
          const upserted = await hub.upsertCloudflareAccount(
            factsUpsert(row, { tokenStatus: "expiring", parentExpiresAt }),
          );
          summary.expiring++;
          if (!upserted.ok) summary.failures++;
          continue;
        }

        // Healthy: refresh the verified granted-policy set best-effort — a
        // failed policy read never degrades the health verdict.
        const policies = await getCloudflareTokenPolicies(
          parent!.credential,
          verified.tokenId,
          fetchImpl,
        );
        const upserted = await hub.upsertCloudflareAccount(
          factsUpsert(row, {
            tokenStatus: "active",
            parentExpiresAt,
            ...(policies !== null ? { grantedPolicies: policies } : {}),
          }),
        );
        if (!upserted.ok) summary.failures++;
      } catch {
        summary.failures++;
      }
    }
  } catch {
    summary.failures++;
  }
  return summary;
}
