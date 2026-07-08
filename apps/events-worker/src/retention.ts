import type { EventsRepository } from "@saas/db/events";
import { checkBillingEntitlement } from "./billing-client.js";
import { orgPublicId } from "./ids.js";

/**
 * The retention sweep (saas-event-streaming ES7). Enforces
 * `limit.event_retention_days` on `events.event_log` + `events.audit_entries`
 * per org (with the design §10 security-category floor), then ages dead letters
 * and closed groups out on fixed platform windows. All deletes are batched
 * keyset scans capped per tick, so one sweep is bounded work regardless of
 * backlog and drains across successive off-peak ticks.
 *
 * Best-effort per org: one org's entitlement-check or delete failure is counted
 * and skipped, never aborting the sweep. Fail-safe on the entitlement seam — an
 * org whose retention window cannot be confirmed (unlimited, denied, or a
 * service error) is NOT swept, so a transient billing failure can never delete
 * data.
 */

/** Rows deleted per batch statement. */
export const RETENTION_BATCH_SIZE = 1000;
/** Batches per (org, resource) per tick — the per-tick work cap. */
export const RETENTION_MAX_BATCHES = 5;
/** Fixed platform window (days) after which a terminal dead letter is purged. */
export const DEAD_LETTER_RETENTION_DAYS = 30;
/** Fixed platform window (days) after which a CLOSED group is purged. */
export const CLOSED_GROUP_RETENTION_DAYS = 30;
/** How far back org discovery looks for orgs to sweep (recency-bounded scan). */
export const RETENTION_ORG_LOOKBACK_DAYS = 30;
const RETENTION_ORG_LIMIT = 1000;

const RETENTION_ENTITLEMENT_KEY = "limit.event_retention_days";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  eventsRepo: EventsRepository;
  /** Entitlement seam. When absent, per-org sweeps are skipped (fail-safe). */
  billingWorker?: Fetcher | undefined;
  requestId: string;
  now?: () => Date;
}

export interface RetentionSummary {
  orgsSwept: number;
  orgsSkipped: number;
  eventsDeleted: number;
  auditDeleted: number;
  deadLettersDeleted: number;
  groupsDeleted: number;
  errors: number;
}

/**
 * Loop a single batched delete up to the per-tick cap, stopping early once a
 * batch drains (returns fewer than the batch size). Returns total deleted and
 * whether the loop hit an infra error.
 */
async function drain(
  del: (limit: number) => Promise<{ ok: true; value: number } | { ok: false; error: unknown }>,
): Promise<{ deleted: number; errored: boolean }> {
  let deleted = 0;
  for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
    const result = await del(RETENTION_BATCH_SIZE);
    if (!result.ok) return { deleted, errored: true };
    deleted += result.value;
    if (result.value < RETENTION_BATCH_SIZE) break;
  }
  return { deleted, errored: false };
}

export async function runRetentionSweep(deps: RetentionDeps): Promise<RetentionSummary> {
  const now = deps.now ? deps.now() : new Date();
  const summary: RetentionSummary = {
    orgsSwept: 0,
    orgsSkipped: 0,
    eventsDeleted: 0,
    auditDeleted: 0,
    deadLettersDeleted: 0,
    groupsDeleted: 0,
    errors: 0,
  };

  // --- Per-org event/audit sweep, gated on limit.event_retention_days --------
  if (deps.billingWorker) {
    const since = new Date(now.getTime() - RETENTION_ORG_LOOKBACK_DAYS * MS_PER_DAY).toISOString();
    const orgsResult = await deps.eventsRepo.listRecentlyActiveOrgIds(since, RETENTION_ORG_LIMIT);
    if (!orgsResult.ok) {
      summary.errors++;
    } else {
      for (const orgId of orgsResult.value) {
        const decision = await checkBillingEntitlement(
          deps.billingWorker,
          orgPublicId(orgId),
          RETENTION_ENTITLEMENT_KEY,
          deps.requestId,
        );
        // Fail-safe: only sweep when a concrete numeric retention window is
        // confirmed. Unlimited (null), disabled, or a service error → skip.
        if (decision.kind !== "decision") {
          summary.orgsSkipped++;
          continue;
        }
        const d = decision.decision;
        if (!d.allowed) {
          summary.orgsSkipped++;
          continue;
        }
        const days = d.limitValue;
        if (typeof days !== "number" || days <= 0) {
          summary.orgsSkipped++;
          continue;
        }

        const cutoffIso = new Date(now.getTime() - days * MS_PER_DAY).toISOString();

        // Audit entries FIRST: a non-security audit references its event_log
        // row, so removing the audit projection before the raw log keeps the
        // FK valid. Security audits survive (the §10 floor) and so do their
        // log rows (the deleteExpiredEvents security guard).
        const audit = await drain((limit) => deps.eventsRepo.deleteExpiredAuditEntries(orgId, cutoffIso, limit));
        summary.auditDeleted += audit.deleted;

        const events = await drain((limit) => deps.eventsRepo.deleteExpiredEvents(orgId, cutoffIso, limit));
        summary.eventsDeleted += events.deleted;

        if (audit.errored || events.errored) {
          summary.errors++;
        } else {
          summary.orgsSwept++;
        }
      }
    }
  }

  // --- Fixed-window platform sweeps (all orgs), run once per tick -------------
  const deadLetterCutoff = new Date(now.getTime() - DEAD_LETTER_RETENTION_DAYS * MS_PER_DAY).toISOString();
  const dl = await drain((limit) => deps.eventsRepo.deleteExpiredDeadLetters(deadLetterCutoff, limit));
  summary.deadLettersDeleted += dl.deleted;
  if (dl.errored) summary.errors++;

  const groupCutoff = new Date(now.getTime() - CLOSED_GROUP_RETENTION_DAYS * MS_PER_DAY).toISOString();
  const groups = await drain((limit) => deps.eventsRepo.deleteClosedGroupsBefore(groupCutoff, limit));
  summary.groupsDeleted += groups.deleted;
  if (groups.errored) summary.errors++;

  return summary;
}
