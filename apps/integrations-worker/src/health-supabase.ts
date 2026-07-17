// Supabase connection-health cron (saas-integration-hub IH9, design §5.3):
// refresh-token liveness + project-list refresh.
//
// Per active Supabase connection: derive a fresh access token from the
// refresh token in custody (`grant_type=refresh_token`).
//   refused → the grant was revoked provider-side: connection suspended +
//     `integration.suspended` event with reason "refresh_failed" (the
//     console's re-auth CTA rides this). Custody is NOT zeroized — a
//     re-auth overwrites it, and zeroizing early buys nothing.
//   success → Supabase ROTATED the refresh token on use: the rotated token is
//     re-enveloped into custody FIRST (dropping it would strand the
//     connection), then the project facts are refreshed best-effort.
// Dormant (checked = 0) until the environment's Supabase OAuth app exists.
// Best-effort throughout: per-row failures are counted, never thrown.

import type { Env } from "./env.js";
import { INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import {
  createIntegrationHubRepository,
  createIntegrationsRepository,
} from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import type { FetchLike } from "./github-app.js";
import {
  fetchSupabaseProjectServiceKeys,
  listSupabaseProjects,
  refreshSupabaseAccess,
} from "./providers/supabase.js";
import { readParentCredential, reEnvelopeParentCredential } from "./custody.js";
import { createEncryptionAdapter } from "./encryption.js";
import { generateRequestId, generateUuid, orgPublicId } from "./ids.js";

export interface SupabaseHealthSummary {
  checked: number;
  suspended: number;
  refreshed: number;
  failures: number;
}

/** Bounded orgs per run — hourly cadence; stalest rows go first. */
export const SUPABASE_HEALTH_LIMIT = 50;

export async function runSupabaseHealth(
  env: Env,
  executor: SqlExecutor,
  opts?: { fetchImpl?: FetchLike; now?: Date; limit?: number },
): Promise<SupabaseHealthSummary> {
  const summary: SupabaseHealthSummary = { checked: 0, suspended: 0, refreshed: 0, failures: 0 };
  // Dormant until the per-environment Supabase OAuth app is configured
  // (risks D4) — without it no refresh call can be signed.
  if (!env.SUPABASE_OAUTH_CLIENT_ID || !env.SUPABASE_OAUTH_CLIENT_SECRET) return summary;
  const credentials = {
    clientId: env.SUPABASE_OAUTH_CLIENT_ID,
    clientSecret: env.SUPABASE_OAUTH_CLIENT_SECRET,
  };
  const now = opts?.now ?? new Date();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const limit = opts?.limit ?? SUPABASE_HEALTH_LIMIT;

  try {
    const hub = createIntegrationHubRepository(executor);
    const integrations = createIntegrationsRepository(executor);
    const events = createEventsRepository(executor);
    const listed = await hub.listSupabaseOrgsForSweep(limit);
    if (!listed.ok) {
      summary.failures++;
      return summary;
    }

    for (const row of listed.value) {
      if (!row.connectionId || row.connectionStatus !== "active") continue;
      summary.checked++;
      try {
        const connectionUuid = asUuid(row.connectionId);
        const parent = await readParentCredential(env, executor, connectionUuid, "supabase");
        if (!parent) {
          // Custody unreadable is OUR problem (key/envelope), not evidence the
          // grant died provider-side — count a failure, don't suspend.
          summary.failures++;
          continue;
        }

        const grant = await refreshSupabaseAccess(credentials, parent.credential, fetchImpl);
        if (!grant) {
          // Provider refused the refresh: the grant was revoked provider-side.
          // Do NOT zeroize custody — a re-auth overwrites it.
          const suspended = await integrations.updateConnectionStatus(
            asUuid(row.orgId),
            connectionUuid,
            "suspended",
          );
          if (!suspended.ok) {
            summary.failures++;
            continue;
          }
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
                provider: "supabase",
                orgId: orgPublicId(row.orgId),
                reason: "refresh_failed",
              },
            },
            audit: {
              id: generateUuid(),
              category: "integrations",
              description:
                "Supabase refresh token refused provider-side — connection suspended (re-auth required)",
            },
          });
          if (!emitted.ok) summary.failures++;
          summary.suspended++;
          continue;
        }

        // The refresh ROTATED the parent — re-envelope FIRST, before any other
        // call can fail: a dropped rotation strands the connection (the old
        // refresh token is already consumed).
        if (grant.refreshToken !== parent.credential) {
          const reEnveloped = await reEnvelopeParentCredential(
            env,
            executor,
            connectionUuid,
            "supabase_refresh_token",
            grant.refreshToken,
            parent.externalRef,
          );
          if (!reEnveloped) {
            summary.failures++;
            continue;
          }
        }

        // Project-list refresh, best-effort: a failed listing never degrades
        // the liveness verdict.
        const projects = await listSupabaseProjects(grant.accessToken, fetchImpl);
        if (projects !== null) {
          await hub.upsertSupabaseOrg({
            id: row.id,
            connectionId: connectionUuid,
            supabaseOrgId: row.supabaseOrgId,
            orgName: row.orgName,
            grantedScopes: row.grantedScopes,
            projects,
          });

          // SI4 reconcile: keep the org-owned per-project service-key custody
          // (the `project-service-key` template's source) in step with the
          // project list — new projects gain entries; a failed read never
          // overwrites good keys. Best-effort like the facts refresh.
          try {
            const keys = await fetchSupabaseProjectServiceKeys(
              grant.accessToken,
              projects.map((p) => p.ref),
              fetchImpl,
            );
            const encryption = keys ? await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY) : null;
            if (keys && encryption) {
              const envelope = await encryption.encrypt(JSON.stringify(keys));
              await hub.upsertProviderCredential({
                id: generateUuid(),
                connectionId: connectionUuid,
                kind: "supabase_project_secret",
                ciphertext: JSON.stringify(envelope),
                scopes: Object.keys(keys),
                externalRef: row.supabaseOrgId,
              });
            }
          } catch {
            // Best-effort.
          }
        }
        summary.refreshed++;
      } catch {
        summary.failures++;
      }
    }
  } catch {
    summary.failures++;
  }
  return summary;
}
