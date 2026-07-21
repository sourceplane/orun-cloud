/**
 * Provider-rotation engine (provider-rotated-secrets RS2).
 *
 * The scheduled pass that keeps provider-rotated secrets fresh: for each due
 * secret (rotation_policy elapsed, or the stored token's expires_at inside the
 * grace window — the stalled-schedule backstop), it re-mints the value from the
 * connected parent (purpose "rotation", the RS1 path), encrypts it, and appends
 * it as a new version in ONE atomic statement — mint → encrypt → append →
 * stamp. Non-destructive by construction: any step failing leaves the prior
 * version current and valid; the failure is surfaced as an alert-worthy
 * `secret.rotation_failed` event and the engine retries next tick.
 *
 * Retire-old posture (v1): the PRIOR minted token is not explicitly revoked —
 * every rotation mint carries a provider-side `expires_on` of interval + grace,
 * so the old token dies on its own ~grace after the new one lands. The grace
 * overlap keeps in-flight work valid; the IH9 orphan sweep reconciles. Explicit
 * broker revoke tightens this window in RS3.
 *
 * Re-delivery: a secret with `rotation_deliver_target` set has a long-lived
 * consumer HOLDING the prior value. The engine still rotates (the stored token
 * dies at expires_at regardless), and flags `deliveryRequired: true` on the
 * `secret.rotated` event so the delivery lane (SS5 onRotate / a redeploy) can
 * converge the consumer before the grace window closes.
 *
 * Never a value in any event, log, or error. Bounded batch; never throws out
 * of the scheduled handler.
 */

import type { Env } from "./env.js";
import type { ConfigRepository, ProviderRotationDue } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import type { InternalMintCredentialRequest } from "@saas/contracts/integrations";
import { createConfigRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid, type Uuid } from "@saas/db/ids";
import { mintBrokeredCredential, type BrokeredMintOutcome } from "./integrations-client.js";
import { connectionPublicId, generateRequestId } from "./ids.js";
import { SECRET_EVENT_TYPES } from "./secret-events.js";
import type { EncryptionAdapter } from "./encryption.js";

/** Bounded batch per run — a backlog drains over runs. */
const DEFAULT_BATCH = 50;
/** RS-D2 defaults: 30d interval, 24h grace. */
const DEFAULT_INTERVAL_SECONDS = 30 * 86400;
const DEFAULT_GRACE_SECONDS = 86400;

const ROTATION_POLICY_RE = /^[0-9]+[hdwmy]$/;
const UNIT_SECONDS: Record<string, number> = {
  h: 3600,
  d: 86400,
  w: 7 * 86400,
  m: 30 * 86400,
  y: 365 * 86400,
};

function policySeconds(policy: string | null): number {
  if (!policy || !ROTATION_POLICY_RE.test(policy)) return DEFAULT_INTERVAL_SECONDS;
  const unit = policy[policy.length - 1]!;
  return Number(policy.slice(0, -1)) * UNIT_SECONDS[unit]!;
}

export interface RotationEngineDeps {
  repo: Pick<ConfigRepository, "listSecretsDueForProviderRotation" | "rotateProviderSecret">;
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit">;
  /** The rotation mint seam (tests). Production wires mintBrokeredCredential
   * (purpose "rotation") over the INTEGRATIONS_WORKER service binding. */
  mintRotation: (req: InternalMintCredentialRequest) => Promise<BrokeredMintOutcome>;
  /** Workspace-bound adapter factory (SM2: the DEK is per-org). */
  encryptionAdapterFor: (orgId: string) => Promise<EncryptionAdapter | null>;
  now?: () => Date;
  generateId?: () => string;
  limit?: number;
}

export interface RotationEngineSummary {
  scanned: number;
  rotated: number;
  failed: number;
}

/** The system actor uuid stamped as created_by on engine-rotated versions. */
const ENGINE_ACTOR_UUID = "00000000-0000-0000-0000-000000000000";

export async function runRotationEngine(
  env: Env,
  deps?: RotationEngineDeps,
): Promise<RotationEngineSummary | null> {
  // Dormant without the seams it needs (dev / partial wiring): fail SAFE —
  // rotating with a broken seam is worse than not rotating (the reminder
  // sweep + expiry lane still surface staleness).
  if (!deps && (!env.PLATFORM_DB || !env.INTEGRATIONS_WORKER)) return null;

  const now = deps?.now ? deps.now() : new Date();
  const genId = deps?.generateId ?? (() => crypto.randomUUID());
  const limit = deps?.limit ?? DEFAULT_BATCH;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);
    const mintRotation =
      deps?.mintRotation ??
      ((req: InternalMintCredentialRequest) =>
        mintBrokeredCredential(env.INTEGRATIONS_WORKER!, req, generateRequestId()));
    const adapterFor =
      deps?.encryptionAdapterFor ??
      (async (orgId: string) => {
        const { createSecretEncryptionAdapter } = await import("./encryption.js");
        return createSecretEncryptionAdapter(env, orgId);
      });

    const dueResult = await repo.listSecretsDueForProviderRotation(now, limit);
    if (!dueResult.ok) return null;
    const due = dueResult.value;
    if (due.length === 0) return { scanned: 0, rotated: 0, failed: 0 };

    let rotated = 0;
    let failed = 0;
    for (const secret of due) {
      try {
        const outcome = await rotateOne(repo, mintRotation, adapterFor, secret);
        if (outcome.ok) {
          rotated += 1;
          await emitRotated(eventsRepo, genId, now, secret, outcome.version, outcome.expiresAt);
        } else {
          failed += 1;
          await emitFailed(eventsRepo, genId, now, secret, outcome.reason);
        }
      } catch (err) {
        // A single secret failing must never break the batch or the cron.
        failed += 1;
        console.error(`[rotation-engine] rotation failed for secret ${secret.id}: ${String(err)}`);
      }
    }
    return { scanned: due.length, rotated, failed };
  } catch (err) {
    console.error(`[rotation-engine] failed: ${String(err)}`);
    return null;
  } finally {
    if (executor) await executor.dispose();
  }
}

type RotateOneOutcome =
  | { ok: true; version: number; expiresAt: Date | null }
  | { ok: false; reason: string };

async function rotateOne(
  repo: Pick<ConfigRepository, "rotateProviderSecret">,
  mintRotation: (req: InternalMintCredentialRequest) => Promise<BrokeredMintOutcome>,
  adapterFor: (orgId: string) => Promise<EncryptionAdapter | null>,
  secret: ProviderRotationDue,
): Promise<RotateOneOutcome> {
  // 1. Mint the next value from the connected parent. TTL = interval + grace
  //    so the NEW token outlives the next rotation too (RS1's create math).
  const ttlSeconds =
    policySeconds(secret.rotationPolicy) + (secret.rotationGraceSeconds ?? DEFAULT_GRACE_SECONDS);
  const mint = await mintRotation({
    orgId: secret.orgId,
    connectionId: connectionPublicId(secret.rotationConnectionId),
    template: secret.rotationTemplate,
    ...(secret.rotationParams && Object.keys(secret.rotationParams).length > 0
      ? { params: secret.rotationParams }
      : {}),
    ttlSeconds,
    purpose: "rotation",
    requestedBy: null,
    requestedByType: "system",
  });
  if (!mint.ok) {
    // Typed, value-free reason: orphaned connection, refused parent grant,
    // broker outage — all non-destructive; the prior version stays current.
    return { ok: false, reason: mint.reason };
  }

  // 2. Encrypt under the workspace adapter. The minted value exists only in
  //    this scope; it is never logged and never leaves except as ciphertext.
  const adapter = await adapterFor(secret.orgId);
  if (!adapter) {
    return { ok: false, reason: "encryption_unavailable" };
  }
  let envelope: string;
  try {
    envelope = JSON.stringify(await adapter.encrypt(mint.value));
  } catch {
    return { ok: false, reason: "encryption_failed" };
  }

  // 3. Append the new version + stamp, one atomic statement. Guarded to a
  //    provider-rotated static head — not_found means the secret was revoked
  //    or repointed since the due scan; treat as a benign skip-with-reason.
  const mintExpiry = new Date(mint.expiresAt);
  const stored = await repo.rotateProviderSecret(
    secret.orgId,
    secret.id,
    asUuid(ENGINE_ACTOR_UUID) as Uuid,
    envelope,
    isNaN(mintExpiry.getTime()) ? null : mintExpiry,
  );
  if (!stored.ok) {
    return { ok: false, reason: stored.error.kind === "not_found" ? "head_changed" : "store_failed" };
  }
  return { ok: true, version: stored.value.version, expiresAt: stored.value.expiresAt };
}

async function emitRotated(
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit">,
  genId: () => string,
  now: Date,
  secret: ProviderRotationDue,
  version: number,
  expiresAt: Date | null,
): Promise<void> {
  await eventsRepo.appendEventWithAudit({
    event: {
      id: genId(),
      type: SECRET_EVENT_TYPES.ROTATED,
      version: 1,
      source: "config-worker",
      occurredAt: now,
      actorType: "system",
      actorId: "rotation-engine",
      orgId: secret.orgId,
      projectId: secret.projectId,
      environmentId: secret.environmentId,
      subjectKind: "secret",
      subjectId: secret.id,
      subjectName: secret.secretKey,
      requestId: `cron-rotation-${genId()}`,
      // Metadata only — NEVER a value.
      payload: {
        key: secret.secretKey,
        scope: secret.scopeKind,
        provider: secret.rotationProvider,
        template: secret.rotationTemplate,
        version,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        // A long-lived consumer still holds the PRIOR value: the delivery
        // lane must converge it before the old token's grace window closes.
        deliveryRequired: secret.rotationDeliverTarget !== null,
        ...(secret.rotationDeliverTarget ? { deliverTarget: secret.rotationDeliverTarget } : {}),
      },
    },
    audit: {
      id: genId(),
      category: "config",
      description: `Secret rotated by engine: ${secret.secretKey} (${secret.rotationProvider}/${secret.rotationTemplate} → v${version})`,
      projectId: secret.projectId,
      environmentId: secret.environmentId,
    },
  });
}

async function emitFailed(
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit">,
  genId: () => string,
  now: Date,
  secret: ProviderRotationDue,
  reason: string,
): Promise<void> {
  await eventsRepo.appendEventWithAudit({
    event: {
      id: genId(),
      type: SECRET_EVENT_TYPES.ROTATION_FAILED,
      version: 1,
      source: "config-worker",
      occurredAt: now,
      actorType: "system",
      actorId: "rotation-engine",
      orgId: secret.orgId,
      projectId: secret.projectId,
      environmentId: secret.environmentId,
      subjectKind: "secret",
      subjectId: secret.id,
      subjectName: secret.secretKey,
      requestId: `cron-rotation-${genId()}`,
      // Metadata + typed reason only — NEVER a value.
      payload: {
        key: secret.secretKey,
        scope: secret.scopeKind,
        provider: secret.rotationProvider,
        template: secret.rotationTemplate,
        reason,
        expiresAt: secret.expiresAt ? secret.expiresAt.toISOString() : null,
      },
    },
    audit: {
      id: genId(),
      category: "config",
      description: `Secret rotation FAILED: ${secret.secretKey} (${secret.rotationProvider}/${secret.rotationTemplate} — ${reason})`,
      projectId: secret.projectId,
      environmentId: secret.environmentId,
    },
  });
}
