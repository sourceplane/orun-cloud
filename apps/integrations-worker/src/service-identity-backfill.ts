// Service-identity backfill sweep (SI3, sub-epics/service-identity-bootstrap).
//
// Upgrades EXISTING Cloudflare OAuth connections from user-derived
// refresh-token custody to the provisioned account-owned service token —
// the same end state SI2 gives fresh connects. Per active connection whose
// custody is `cloudflare_refresh_token`, under the connection's mint lock
// (the upgrade is a custody read-modify-write, exactly the race the lock
// serializes):
//
//   refresh once (re-envelope the rotated refresh token FIRST — crash-safety:
//   every early exit leaves valid refresh custody) → provision the service
//   token → PROBE it (`GET /user/tokens/verify` with the new token — never
//   swap custody onto an unverified credential) → upsert service custody →
//   facts carry the token id → delete refresh custody → emit
//   `integration.connection.upgraded`.
//
// Failure leaves the connection exactly as it was (refresh custody intact,
// re-enveloped); a failed swap orphans at most one provider-side token named
// `orun/{org}/service`, which the IH9 sweep and the next run's provisioning
// converge. Idempotent: a connection already on service custody only has its
// lingering refresh row dropped (the crashed-between-swap-and-delete case).
// The sweep self-quiesces — no refresh custody, no work.

import type { Env } from "./env.js";
import { INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import {
  createIntegrationHubRepository,
  createIntegrationsRepository,
  type CloudflareAccount,
} from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import type { FetchLike } from "./github-app.js";
import {
  provisionCloudflareServiceIdentity,
  refreshCloudflareAccess,
  rotateCloudflareServiceIdentity,
  verifyCloudflareAccountToken,
} from "./providers/cloudflare.js";
import {
  readParentCredential,
  readParentCredentialOfKind,
  reEnvelopeParentCredential,
} from "./custody.js";
import { connectionMintLockRunner, type MintLockRunner } from "./mint-lock.js";
import { createEncryptionAdapter } from "./encryption.js";
import { generateRequestId, generateUuid, orgPublicId } from "./ids.js";

export interface ServiceIdentityBackfillSummary {
  scanned: number;
  upgraded: number;
  /** Connections already on infrastructure custody (nothing to do). */
  alreadyMigrated: number;
  /** Grant cannot self-provision (SI-D1) — stays on refresh custody. */
  grantInsufficient: number;
  failures: number;
}

/** Bounded connections per run — hourly cadence; stalest rows go first. */
export const SERVICE_IDENTITY_BACKFILL_LIMIT = 25;

export async function runServiceIdentityBackfill(
  env: Env,
  executor: SqlExecutor,
  opts?: { fetchImpl?: FetchLike; now?: Date; limit?: number; mintLock?: MintLockRunner },
): Promise<ServiceIdentityBackfillSummary> {
  const summary: ServiceIdentityBackfillSummary = {
    scanned: 0,
    upgraded: 0,
    alreadyMigrated: 0,
    grantInsufficient: 0,
    failures: 0,
  };
  // Refresh custody can only be exercised through the OAuth client; without
  // one there is nothing to upgrade FROM (paste-posture connections are
  // already infrastructure-class).
  const oauth =
    env.CLOUDFLARE_OAUTH_CLIENT_ID && env.CLOUDFLARE_OAUTH_CLIENT_SECRET
      ? { clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID, clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET }
      : null;
  if (!oauth) return summary;

  const now = opts?.now ?? new Date();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const limit = opts?.limit ?? SERVICE_IDENTITY_BACKFILL_LIMIT;
  const runLocked = opts?.mintLock ?? connectionMintLockRunner(env.MINT_LOCKS);

  try {
    const hub = createIntegrationHubRepository(executor);
    const listed = await hub.listCloudflareAccountsForSweep(limit);
    if (!listed.ok) {
      summary.failures++;
      return summary;
    }

    for (const row of listed.value) {
      if (!row.connectionId || row.connectionStatus !== "active") continue;
      summary.scanned++;
      try {
        const outcome = await upgradeConnection(env, executor, oauth, row, now, fetchImpl, runLocked);
        summary[outcome]++;
      } catch {
        summary.failures++;
      }
    }
  } catch {
    summary.failures++;
  }
  return summary;
}

type UpgradeOutcome = "upgraded" | "alreadyMigrated" | "grantInsufficient" | "failures";

async function upgradeConnection(
  env: Env,
  executor: SqlExecutor,
  oauth: { clientId: string; clientSecret: string },
  row: CloudflareAccount & { orgId: string; connectionStatus: string },
  now: Date,
  fetchImpl: FetchLike,
  runLocked: MintLockRunner,
): Promise<UpgradeOutcome> {
  const hub = createIntegrationHubRepository(executor);
  const connectionUuid = asUuid(row.connectionId!);

  // The whole upgrade is one custody critical section: the same lock the
  // mint path holds, so an in-flight mint can't read the refresh token we
  // are about to retire (or rotate it after our read).
  const section = await runLocked(String(row.connectionId), async (): Promise<UpgradeOutcome> => {
    // Infrastructure custody present → nothing to upgrade. Converge the
    // crashed-between-swap-and-delete case: a lingering refresh row is
    // identity-class material that must not outlive the upgrade.
    const infrastructure = await readParentCredential(env, executor, connectionUuid, "cloudflare");
    if (infrastructure) {
      await hub.deleteProviderCredential(connectionUuid, "cloudflare_refresh_token");
      return "alreadyMigrated";
    }
    // SI5: refresh custody is no longer a mint candidate — the backfill (a
    // lifecycle surface) reads it explicitly.
    const parent = await readParentCredentialOfKind(
      env,
      executor,
      connectionUuid,
      "cloudflare_refresh_token",
    );
    if (!parent) return "failures";

    // Refresh once — the ONLY use of the user-derived credential in this
    // sweep. Re-envelope a rotation immediately: every exit below this point
    // leaves valid refresh custody behind.
    const grant = await refreshCloudflareAccess(oauth, parent.credential, fetchImpl);
    if (!grant) return "failures"; // Health cron owns dead-grant suspension.
    if (grant.refreshToken !== parent.credential) {
      const reEnveloped = await reEnvelopeParentCredential(
        env,
        executor,
        connectionUuid,
        "cloudflare_refresh_token",
        grant.refreshToken,
        parent.externalRef,
      );
      if (!reEnveloped) return "failures";
    }

    const provisioned = await provisionCloudflareServiceIdentity(
      {
        bootstrapCredential: grant.accessToken,
        externalRef: row.accountExternalId,
        identityRef: `orun/${orgPublicId(row.orgId)}/service`,
        nowMs: now.getTime(),
      },
      fetchImpl,
    );
    if (!provisioned.ok) {
      return provisioned.reason === "bootstrap_grant_insufficient" ? "grantInsufficient" : "failures";
    }

    // Probe-mint gate: never swap custody onto a credential the provider
    // won't honor. The provisioned token is ACCOUNT-OWNED, so it verifies on
    // the account endpoint (`/user/tokens/verify` 401s for account tokens).
    // A failed probe deletes the just-created token best-effort.
    const probe = await verifyCloudflareAccountToken(
      provisioned.value.credential,
      row.accountExternalId,
      fetchImpl,
    );
    if (!probe || probe.status !== "active") {
      await deleteProvisionedToken(row.accountExternalId, provisioned.value, fetchImpl);
      return "failures";
    }

    const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
    if (!encryption) {
      await deleteProvisionedToken(row.accountExternalId, provisioned.value, fetchImpl);
      return "failures";
    }
    const envelope = await encryption.encrypt(provisioned.value.credential);
    const stored = await hub.upsertProviderCredential({
      id: generateUuid(),
      connectionId: connectionUuid,
      kind: "cloudflare_service_token",
      ciphertext: JSON.stringify(envelope),
      scopes: provisioned.value.scopes ?? null,
      externalRef: row.accountExternalId,
    });
    if (!stored.ok) {
      await deleteProvisionedToken(row.accountExternalId, provisioned.value, fetchImpl);
      return "failures";
    }

    // Facts carry the identity's provider-side id (verify/rotate/revoke);
    // connect-time anchors preserved.
    await hub.upsertCloudflareAccount({
      id: row.id,
      connectionId: connectionUuid,
      accountExternalId: row.accountExternalId,
      accountName: row.accountName,
      parentTokenRef: provisioned.value.providerRef,
      grantedPolicies: row.grantedPolicies,
      tokenStatus: "active",
      parentExpiresAt: null,
    });

    // The user-derived credential is retired. (A crash before this line is
    // the alreadyMigrated-converge case above.)
    await hub.deleteProviderCredential(connectionUuid, "cloudflare_refresh_token");
    return "upgraded";
  });
  if (!section.ok) return "failures"; // Lock wait exhausted — next run retries.
  const outcome = section.value;

  // SI5: a grant that cannot self-provision leaves the connection unable to
  // mint (refresh custody is no longer a candidate) — an "active" status
  // would be a lie. Suspend with a typed reason; the console's re-connect
  // CTA (re-authorize with token administration, or token paste) rides it.
  if (outcome === "grantInsufficient") {
    try {
      const integrations = createIntegrationsRepository(executor);
      const suspended = await integrations.updateConnectionStatus(
        asUuid(row.orgId),
        connectionUuid,
        "suspended",
      );
      if (suspended.ok) {
        const events = createEventsRepository(executor);
        await events.appendEventWithAudit({
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
            subjectId: row.connectionId!,
            subjectName: null,
            requestId: generateRequestId(),
            payload: {
              provider: "cloudflare",
              orgId: orgPublicId(row.orgId),
              reason: "service_identity_required",
            },
          },
          audit: {
            id: generateUuid(),
            category: "integrations",
            description:
              "Cloudflare connection suspended: the OAuth grant cannot provision a service identity (re-connect with token administration, or paste an account API token)",
          },
        });
      }
    } catch {
      // Best-effort; the next sweep re-suspends.
    }
  }

  if (outcome === "upgraded") {
    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: INTEGRATION_EVENT_TYPES.CONNECTION_UPGRADED,
          version: 1,
          source: "integrations-worker",
          occurredAt: now,
          actorType: "system",
          actorId: "integrations-worker",
          orgId: row.orgId,
          subjectKind: "integration_connection",
          subjectId: row.connectionId!,
          subjectName: null,
          requestId: generateRequestId(),
          payload: {
            provider: "cloudflare",
            orgId: orgPublicId(row.orgId),
            from: "cloudflare_refresh_token",
            to: "cloudflare_service_token",
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description:
            "Cloudflare custody upgraded: user-derived refresh token retired for a provisioned service identity",
        },
      });
    } catch {
      // Best-effort: the upgrade is already durable.
    }
  }
  return outcome;
}

// ── Scheduled rotation (SI5) ────────────────────────────────

export interface ServiceIdentityRotationSummary {
  scanned: number;
  rotated: number;
  failures: number;
}

/** Rotate service tokens whose secret material is older than this. */
export const SERVICE_IDENTITY_ROTATION_DAYS = 30;

/** Bounded connections per run — the sweep is daily. */
export const SERVICE_IDENTITY_ROTATION_LIMIT = 25;

/**
 * Scheduled service-token rotation (SI5): "rotation is a cron, not a
 * consent." Per active Cloudflare connection on service custody whose value
 * is older than SERVICE_IDENTITY_ROTATION_DAYS, roll the token value in
 * place (same provider-side id) under the connection mint lock and
 * re-envelope. Failure leaves the current (still valid) value in custody —
 * the next daily run retries.
 */
export async function runServiceIdentityRotation(
  env: Env,
  executor: SqlExecutor,
  opts?: { fetchImpl?: FetchLike; now?: Date; limit?: number; mintLock?: MintLockRunner },
): Promise<ServiceIdentityRotationSummary> {
  const summary: ServiceIdentityRotationSummary = { scanned: 0, rotated: 0, failures: 0 };
  const now = opts?.now ?? new Date();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const limit = opts?.limit ?? SERVICE_IDENTITY_ROTATION_LIMIT;
  const runLocked = opts?.mintLock ?? connectionMintLockRunner(env.MINT_LOCKS);
  const maxAgeMs = SERVICE_IDENTITY_ROTATION_DAYS * 24 * 60 * 60 * 1000;

  try {
    const hub = createIntegrationHubRepository(executor);
    const listed = await hub.listCloudflareAccountsForSweep(limit);
    if (!listed.ok) {
      summary.failures++;
      return summary;
    }

    for (const row of listed.value) {
      if (!row.connectionId || row.connectionStatus !== "active" || !row.parentTokenRef) continue;
      try {
        const connectionUuid = asUuid(row.connectionId);
        const custody = await hub.getProviderCredential(connectionUuid, "cloudflare_service_token");
        if (!custody.ok) continue; // paste/legacy posture — nothing to rotate
        summary.scanned++;
        const materialAge =
          now.getTime() - (custody.value.rotatedAt ?? custody.value.createdAt).getTime();
        if (materialAge < maxAgeMs) continue;

        const tokenRef = row.parentTokenRef;
        const section = await runLocked(String(row.connectionId), async (): Promise<boolean> => {
          const parent = await readParentCredentialOfKind(
            env,
            executor,
            connectionUuid,
            "cloudflare_service_token",
          );
          if (!parent) return false;
          const rotated = await rotateCloudflareServiceIdentity(
            { current: parent, providerRef: tokenRef, nowMs: now.getTime() },
            fetchImpl,
          );
          if (!rotated.ok) return false;
          // Re-envelope INSIDE the lock: no mint may read the retired value
          // after the provider has already invalidated it.
          return reEnvelopeParentCredential(
            env,
            executor,
            connectionUuid,
            "cloudflare_service_token",
            rotated.value.credential,
            parent.externalRef,
          );
        });
        if (section.ok && section.value) summary.rotated++;
        else summary.failures++;
      } catch {
        summary.failures++;
      }
    }
  } catch {
    summary.failures++;
  }
  return summary;
}

/** Best-effort cleanup of a provisioned-but-unswapped token (its own value is
 *  the bearer — it carries token administration by construction). */
async function deleteProvisionedToken(
  accountExternalId: string,
  identity: { credential: string; providerRef: string | null },
  fetchImpl: FetchLike,
): Promise<void> {
  if (!identity.providerRef) return;
  try {
    await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountExternalId}/tokens/${identity.providerRef}`,
      { method: "DELETE", headers: { authorization: `Bearer ${identity.credential}` } },
    );
  } catch {
    // The IH9 orphan sweep reconciles `orun/{org}/service` names.
  }
}
