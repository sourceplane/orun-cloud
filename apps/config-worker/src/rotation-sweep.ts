/**
 * Rotation / expiry reminder sweep (saas-secret-manager SEC7, pairs orun-secrets
 * SD-3 / platform-integration §3).
 *
 * A scheduled pass that surfaces secrets whose rotation is overdue (their
 * `rotation_policy` interval has elapsed) or which are expiring within a lead
 * window, emitting an alert-worthy `secret.rotation_due` / `secret.expiring`
 * event + audit per due secret so the console + notifications layer can act.
 *
 * Idempotent: each due secret is reminded at most once per suppression window —
 * the repository excludes rows reminded within the window (last_reminded_at), and
 * this sweep stamps last_reminded_at after emitting. Bounded batch, best-effort:
 * a per-secret failure is logged and skipped, and the sweep NEVER throws out of
 * the scheduled handler. No secret value is ever touched — metadata only.
 */

import type { Env } from "./env.js";
import type { ConfigRepository, SecretRotationDue } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import { createConfigRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { SECRET_EVENT_TYPES } from "./secret-events.js";

/** Expiry lead window: warn once a secret is within 7 days of expiry. */
const DEFAULT_LEAD_WINDOW_SECONDS = 7 * 24 * 3600;
/** Re-notify suppression: at most one reminder per secret per day. */
const DEFAULT_SUPPRESS_SECONDS = 24 * 3600;
/** Bounded batch per run — the sweep is periodic, so a backlog drains over runs. */
const DEFAULT_BATCH = 100;

export interface RotationSweepDeps {
  repo: Pick<ConfigRepository, "listSecretsDueForRotation" | "markSecretsReminded">;
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
  leadWindowSeconds?: number;
  suppressSeconds?: number;
  limit?: number;
}

export interface RotationSweepSummary {
  scanned: number;
  reminded: number;
}

export async function runRotationSweep(
  env: Env,
  deps?: RotationSweepDeps,
): Promise<RotationSweepSummary | null> {
  if (!deps && !env.PLATFORM_DB) return null; // dormant without the DB binding (dev)

  const now = deps?.now ? deps.now() : new Date();
  const genId = deps?.generateId ?? (() => crypto.randomUUID());
  const leadWindowSeconds = deps?.leadWindowSeconds ?? DEFAULT_LEAD_WINDOW_SECONDS;
  const suppressSeconds = deps?.suppressSeconds ?? DEFAULT_SUPPRESS_SECONDS;
  const limit = deps?.limit ?? DEFAULT_BATCH;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);

    const dueResult = await repo.listSecretsDueForRotation(now, leadWindowSeconds, suppressSeconds, limit);
    if (!dueResult.ok) return null;
    const due = dueResult.value;
    if (due.length === 0) return { scanned: 0, reminded: 0 };

    const reminded: string[] = [];
    for (const secret of due) {
      try {
        await emitReminder(eventsRepo, genId, now, secret);
        reminded.push(secret.id);
      } catch (err) {
        // A single reminder failing must never break the batch or the cron.
        console.error(`[rotation-sweep] reminder failed for secret ${secret.id}: ${String(err)}`);
      }
    }

    // Stamp last_reminded_at only on the secrets we actually reminded (idempotency).
    if (reminded.length > 0) {
      await repo.markSecretsReminded(reminded, now);
    }

    return { scanned: due.length, reminded: reminded.length };
  } catch (err) {
    console.error(`[rotation-sweep] failed: ${String(err)}`);
    return null;
  } finally {
    if (executor) await executor.dispose();
  }
}

async function emitReminder(
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit">,
  genId: () => string,
  now: Date,
  secret: SecretRotationDue,
): Promise<void> {
  const type =
    secret.dueKind === "expiry" ? SECRET_EVENT_TYPES.EXPIRING : SECRET_EVENT_TYPES.ROTATION_DUE;
  const what = secret.dueKind === "expiry" ? "expiring" : "rotation overdue";
  const result = await eventsRepo.appendEventWithAudit({
    event: {
      id: genId(),
      type,
      version: 1,
      source: "config-worker",
      occurredAt: now,
      actorType: "system",
      actorId: "system",
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
        rotationPolicy: secret.rotationPolicy,
        lastRotatedAt: secret.lastRotatedAt ? secret.lastRotatedAt.toISOString() : null,
        expiresAt: secret.expiresAt ? secret.expiresAt.toISOString() : null,
        ageDays: secret.ageDays,
      },
    },
    audit: {
      id: genId(),
      category: "config",
      description: `Secret ${what}: ${secret.secretKey} (age ${secret.ageDays}d)`,
      projectId: secret.projectId,
      environmentId: secret.environmentId,
    },
  });
  if (!result.ok) {
    throw new Error("Failed to append rotation reminder event");
  }
}
