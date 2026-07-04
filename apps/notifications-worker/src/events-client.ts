import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createEventsRepository } from "@saas/db/events";
import type { Env } from "./env.js";

/**
 * Audit-safe event payload as emitted on the events seam.
 *
 * Payload bodies MUST be redaction-safe — they may carry orgId, notification
 * id, category, templateKey, recipient channel/address, and bounded status
 * data. They MUST NOT carry template substitutions, magic-link codes,
 * tokens, or any raw provider response.
 */
export interface NotificationEventInput {
  type: string;
  notificationId: string;
  orgId: string;
  subjectKind: string;
  subjectId: string;
  actorType: string;
  actorId: string;
  requestId: string;
  correlationId?: string | null;
  payload: Record<string, unknown>;
  category: string;
  description: string;
  occurredAt: Date;
}

/**
 * Append a notification lifecycle event to the canonical event log with its
 * audit projection — the same direct `@saas/db/events` write path every other
 * bounded context uses (saas-event-streaming ES0). The previous incarnation
 * of this seam POSTed the envelope to an events-worker route that never
 * existed, so `notification.*` events silently vanished; writing the log
 * directly makes notification delivery auditable as spec 14 requires.
 *
 * Best-effort: failures do NOT propagate to the caller. The events seam is
 * an audit sink, not a critical path for the enqueue/send happy path; the
 * caller has already persisted the lifecycle row authoritatively.
 *
 * In environments without a PLATFORM_DB binding (local, tests) this function
 * is a no-op — tests inject a stub via the handlers' `deps.emit` seam.
 */
export async function emitEvent(env: Env, input: NotificationEventInput): Promise<void> {
  if (!env.PLATFORM_DB) return;

  let executor: Awaited<ReturnType<typeof createSqlExecutor>> | null = null;
  try {
    executor = createSqlExecutor(env.PLATFORM_DB);
    const events = createEventsRepository(executor);
    await events.appendEventWithAudit({
      event: {
        id: cryptoRandomEventId(),
        type: input.type,
        version: 1,
        source: "notifications-worker",
        occurredAt: input.occurredAt,
        actorType: input.actorType,
        actorId: input.actorId,
        orgId: input.orgId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        requestId: input.requestId,
        correlationId: input.correlationId ?? null,
        payload: input.payload,
      },
      audit: {
        id: cryptoRandomEventId(),
        category: "notifications",
        description: input.description,
      },
    });
  } catch {
    // Audit sink failures must not break the call site.
  } finally {
    if (executor) {
      try {
        await executor.dispose();
      } catch {
        // Disposal failures are as non-critical as the write itself.
      }
    }
  }
}

function cryptoRandomEventId(): string {
  // Hex random — the event log accepts any opaque id; this avoids leaking
  // provider message ids into the envelope.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) hex += buf[i]!.toString(16).padStart(2, "0");
  return `evt_${hex}`;
}
