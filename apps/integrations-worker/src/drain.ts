// The inbox drain (design §6): attribute → lifecycle/normalize → emit.
//
// Mirrors the shipped outbound webhooks discipline, opposite direction:
// cron + table + bounded retries, no Queues. Each delivery is processed
// independently; emission into event_log happens in the same transaction
// that marks the delivery `emitted` (exactly-once by construction, R3).

import type { Env } from "./env.js";
import {
  INTEGRATION_EVENT_TYPES,
  type IntegrationEventType,
  type MessagingEventType,
  type ScmEventType,
} from "@saas/contracts/integrations";
import {
  createIntegrationsRepository,
  type InboundDelivery,
  type IntegrationConnection,
  type IntegrationsRepository,
  type RepoLink,
} from "@saas/db/integrations";
import {
  createStateRepository,
  type StateRepository,
  type WorkspaceLink,
} from "@saas/db/state";
import {
  createMembershipRepository,
  type MembershipRepository,
} from "@saas/db/membership";
import { createEventsRepository, type EventsRepository } from "@saas/db/events";
import { insertWorkObservation, workObservationsFromScm } from "@saas/db/work";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { generateUuid, inboundDeliveryPublicId, orgPublicId, projectPublicId } from "./ids.js";
import {
  installationIdFromPayload,
  LIFECYCLE_EVENT_TYPES,
  normalizeScmEvent,
} from "./normalize.js";
import { processSlackDelivery } from "./slack-drain.js";

const DEFAULT_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
/** Retry backoff: 1m, 2m, 4m, 8m (then terminal `failed`). */
function backoffMs(attempts: number): number {
  return Math.min(2 ** (attempts - 1), 16) * 60_000;
}

export type DeliveryOutcome =
  | { kind: "emitted"; eventType: string }
  | { kind: "skipped"; reason: string }
  | { kind: "retried"; attempts: number }
  | { kind: "failed"; reason: string };

export interface DrainSummary {
  processed: number;
  emitted: number;
  skipped: number;
  retried: number;
  failed: number;
}

export interface ProcessCtx {
  executor: SqlExecutor;
  repo: IntegrationsRepository;
  events: EventsRepository;
  /**
   * Federation reader over state.workspace_links (OV2): when a delivery's repo
   * has no integrations.repo_links claim, the drain resolves the owning
   * workspace by rename-stable (provider, provider_repo_id) — a same-DB read
   * through packages/db, like the events/work reads above.
   */
  state: Pick<StateRepository, "listActiveWorkspaceLinksForProviderRepo">;
  /** Parent-org reader backing the IT10 tenant-safety guard on federation. */
  membership: Pick<MembershipRepository, "getOrganizationById">;
  /** Worker env: Slack custody decrypt + console links (IH3). */
  env: Env;
  now: () => Date;
}

export async function markSkipped(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  reason: string,
  attribution?: { orgId: string; connectionId: string },
): Promise<DeliveryOutcome> {
  await ctx.repo.markInboundDelivery(asUuid(delivery.id), {
    status: "skipped",
    failureReason: reason,
    ...(attribution
      ? { orgId: asUuid(attribution.orgId), connectionId: asUuid(attribution.connectionId) }
      : {}),
  });
  return { kind: "skipped", reason };
}

export async function markRetryOrFail(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  reason: string,
): Promise<DeliveryOutcome> {
  const attempts = delivery.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await ctx.repo.markInboundDelivery(asUuid(delivery.id), {
      status: "failed",
      attempts,
      nextAttemptAt: null,
      failureReason: reason,
    });
    return { kind: "failed", reason };
  }
  await ctx.repo.markInboundDelivery(asUuid(delivery.id), {
    attempts,
    nextAttemptAt: new Date(ctx.now().getTime() + backoffMs(attempts)),
    failureReason: reason,
  });
  return { kind: "retried", attempts };
}

/**
 * Emit one event and mark the delivery `emitted` transactionally when the
 * executor supports transactions; sequential best-effort otherwise (tests).
 */
export async function emitAndMark(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  connection: IntegrationConnection,
  eventType: IntegrationEventType | ScmEventType | MessagingEventType,
  subject: { kind: string; id: string; name?: string | null },
  payload: Record<string, unknown>,
  description: string,
): Promise<DeliveryOutcome> {
  const eventId = generateUuid();
  const build = (events: EventsRepository, repo: IntegrationsRepository) =>
    (async () => {
      const appended = await events.appendEventWithAudit({
        event: {
          id: eventId,
          type: eventType,
          version: 1,
          source: "integrations-worker",
          occurredAt: ctx.now(),
          actorType: "system",
          actorId: "integrations-worker",
          orgId: connection.orgId,
          subjectKind: subject.kind,
          subjectId: subject.id,
          subjectName: subject.name ?? null,
          requestId: inboundDeliveryPublicId(delivery.id),
          payload,
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description,
        },
      });
      if (!appended.ok) throw new Error("event_append_failed");
      const marked = await repo.markInboundDelivery(asUuid(delivery.id), {
        status: "emitted",
        orgId: asUuid(connection.orgId),
        connectionId: asUuid(connection.id),
        emittedEventId: asUuid(eventId),
        failureReason: null,
      });
      if (!marked.ok) throw new Error("delivery_mark_failed");
    })();

  try {
    const executor = ctx.executor as SqlExecutor & {
      transaction?: <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
    };
    if (typeof executor.transaction === "function") {
      await executor.transaction(async (tx) => {
        await build(createEventsRepository(tx), createIntegrationsRepository(tx));
      });
    } else {
      await build(ctx.events, ctx.repo);
    }
    return { kind: "emitted", eventType };
  } catch {
    return markRetryOrFail(ctx, delivery, "emit_failed");
  }
}

/** Provider lifecycle events: mutate connection/installation state + emit. */
async function processLifecycle(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  connection: IntegrationConnection,
  installationId: number,
): Promise<DeliveryOutcome> {
  const action = delivery.action;
  const orgId = asUuid(connection.orgId);
  const connectionId = asUuid(connection.id);
  const installation = (delivery.payload.installation ?? {}) as Record<string, unknown>;
  const subject = { kind: "integration_connection", id: connection.id };

  if (delivery.eventType === "installation") {
    if (action === "deleted") {
      await ctx.repo.updateConnectionStatus(orgId, connectionId, "revoked");
      await ctx.repo.deleteInstallationToken(connectionId);
      return emitAndMark(
        ctx,
        delivery,
        connection,
        INTEGRATION_EVENT_TYPES.REVOKED,
        subject,
        {
          provider: "github",
          orgId: orgPublicId(connection.orgId),
          externalAccountLogin: connection.externalAccountLogin,
          origin: "provider_uninstall",
        },
        "GitHub App uninstalled on GitHub — connection revoked",
      );
    }
    if (action === "suspend") {
      await ctx.repo.updateConnectionStatus(orgId, connectionId, "suspended");
      return emitAndMark(
        ctx,
        delivery,
        connection,
        INTEGRATION_EVENT_TYPES.SUSPENDED,
        subject,
        { provider: "github", orgId: orgPublicId(connection.orgId) },
        "GitHub installation suspended",
      );
    }
    if (action === "unsuspend") {
      await ctx.repo.updateConnectionStatus(orgId, connectionId, "active");
      return emitAndMark(
        ctx,
        delivery,
        connection,
        INTEGRATION_EVENT_TYPES.REACTIVATED,
        subject,
        { provider: "github", orgId: orgPublicId(connection.orgId) },
        "GitHub installation unsuspended",
      );
    }
    if (action === "new_permissions_accepted") {
      await ctx.repo.upsertGithubInstallation({
        id: generateUuid(),
        connectionId,
        installationId,
        permissions: (installation.permissions as Record<string, unknown>) ?? null,
        events: Array.isArray(installation.events) ? installation.events : null,
        accountLogin: connection.externalAccountLogin,
        accountType: connection.externalAccountType,
      });
      return markSkipped(ctx, delivery, "permissions_updated", {
        orgId: connection.orgId,
        connectionId: connection.id,
      });
    }
    // "created" arrives after the setup callback already activated the
    // connection — nothing to do beyond attribution.
    return markSkipped(ctx, delivery, "lifecycle_noop", {
      orgId: connection.orgId,
      connectionId: connection.id,
    });
  }

  if (delivery.eventType === "installation_repositories") {
    await ctx.repo.upsertGithubInstallation({
      id: generateUuid(),
      connectionId,
      installationId,
      repositorySelection:
        typeof installation.repository_selection === "string"
          ? installation.repository_selection
          : null,
      accountLogin: connection.externalAccountLogin,
      accountType: connection.externalAccountType,
      permissions: (installation.permissions as Record<string, unknown>) ?? null,
      events: Array.isArray(installation.events) ? installation.events : null,
    });
    return emitAndMark(
      ctx,
      delivery,
      connection,
      INTEGRATION_EVENT_TYPES.REPO_SELECTION_CHANGED,
      subject,
      {
        provider: "github",
        orgId: orgPublicId(connection.orgId),
        repositorySelection: installation.repository_selection ?? null,
        action: action,
      },
      "GitHub repository selection changed",
    );
  }

  // github_app_authorization: a user revoked their OAuth grant — installs
  // are unaffected; the identity context owns user-level auth.
  return markSkipped(ctx, delivery, "user_authorization_event", {
    orgId: connection.orgId,
    connectionId: connection.id,
  });
}

/** Process a single inbox row end to end. Exported for the replay handler. */
export async function processDelivery(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
): Promise<DeliveryOutcome> {
  // Defensive: ingest never persists unverified rows, but the drain must not
  // trust that invariant blindly.
  if (!delivery.signatureOk) {
    return markSkipped(ctx, delivery, "signature_unverified");
  }

  // The Slack half of the inbox (IH3): attribution by team_id, messaging.*
  // normalization, Slack lifecycle. Same ledger, same retry discipline.
  if (delivery.provider === "slack") {
    return processSlackDelivery(ctx, delivery);
  }

  const installationId = installationIdFromPayload(delivery.payload);
  if (installationId == null) {
    return markSkipped(ctx, delivery, "no_installation_reference");
  }

  const installation = await ctx.repo.getGithubInstallationByInstallationId(installationId);
  if (!installation.ok || installation.value.connectionId == null) {
    // Unsolicited/orphaned installation traffic: record the installation so
    // admin can see it, but never bind or emit (fail closed, design §4).
    if (!installation.ok) {
      await ctx.repo.upsertGithubInstallation({
        id: generateUuid(),
        connectionId: null,
        installationId,
      });
    }
    return markSkipped(ctx, delivery, "unattributed_installation");
  }

  const connection = await ctx.repo.getConnectionById(asUuid(installation.value.connectionId));
  if (!connection.ok) {
    return markSkipped(ctx, delivery, "connection_missing");
  }

  if (LIFECYCLE_EVENT_TYPES.has(delivery.eventType)) {
    return processLifecycle(ctx, delivery, connection.value, installationId);
  }

  if (connection.value.status === "revoked") {
    return markSkipped(ctx, delivery, "connection_revoked", {
      orgId: connection.value.orgId,
      connectionId: connection.value.id,
    });
  }

  const normalized = normalizeScmEvent(
    delivery.eventType,
    delivery.action,
    delivery.payload,
    orgPublicId(connection.value.orgId),
  );
  if (!normalized) {
    return markSkipped(ctx, delivery, "unsupported_event", {
      orgId: connection.value.orgId,
      connectionId: connection.value.id,
    });
  }

  // IT3 inbound projection: resolve the repo's active link by CONNECTION (not
  // the connection's org), because under an account-shared connection the link
  // is owned by a workspace whose org differs from the account. Single-claim
  // (IT2) guarantees ≤1 link, so the delivery attributes to exactly one owning
  // workspace. The normalized event is emitted to the LINK's org with its
  // projectId + environment. When no integrations claim exists, federate to
  // state.workspace_links (OV2: adding a repo to a workspace binds it) and
  // auto-claim; a repo linked in neither plane emits account-org-scoped only
  // (fail closed — never leaks into a workspace). design §5.
  const link = await ctx.repo.findActiveRepoLinkByConnectionAndRepo(
    asUuid(connection.value.id),
    normalized.repo.externalId,
  );
  const resolved =
    link.ok && link.value
      ? link.value
      : await federateWorkspaceLink(ctx, delivery, connection.value, normalized.repo);
  const targets: Array<{ orgId: string; projectId: string | null; environment: string | null }> =
    resolved
      ? [
          {
            orgId: resolved.orgId,
            projectId: resolved.projectId,
            environment: resolveEnvironment(resolved.branchEnvMap, normalized.payload),
          },
        ]
      : [{ orgId: connection.value.orgId, projectId: null, environment: null }];

  return emitScmEvents(ctx, delivery, connection.value, normalized, targets);
}

/**
 * IT10 tenant-safety guard: may `link`'s org use the delivering connection?
 * Yes when the org OWNS the connection, or when the connection is
 * `account`-scoped and the org is a child workspace of the owning Account
 * (membership parent_org_id) that is admitted under the connection's share
 * mode. This is the DB-level twin of resolveUsableConnection
 * (connection-access.ts) — same relations, read directly instead of via the
 * membership worker. Fails closed: any miss or repo error means "not usable".
 * Without this, a hostile tenant could squat a provider_repo_id in
 * state.workspace_links and siphon another tenant's events.
 */
async function workspaceLinkUsableByConnection(
  ctx: ProcessCtx,
  connection: IntegrationConnection,
  link: WorkspaceLink,
): Promise<boolean> {
  if (link.orgId === connection.orgId) return true;
  // Read-up: only `account`-scoped connections are shareable (IT7).
  if (connection.scope !== "account") return false;
  const org = await ctx.membership.getOrganizationById(link.orgId);
  if (!org.ok || org.value.parentOrgId !== connection.orgId) return false;
  // Admission covers both share modes in one fail-closed query: 'auto' admits
  // every child; 'granted' requires an active grant (D7).
  const admitted = await ctx.repo.isWorkspaceAdmitted(asUuid(connection.id), asUuid(link.orgId));
  return admitted.ok && admitted.value;
}

/**
 * Federation + auto-claim (OV2 → IT2): the repo has no integrations.repo_links
 * claim, so look for the workspace that bound it via the state plane
 * (`orun cloud link` / OV2) on the rename-stable (provider, provider_repo_id).
 * Exactly ONE usable active workspace link → materialize the claim as an
 * integrations.repo_links row (self-healing: the first delivery after deploy
 * claims it) and route there. Zero usable links → null (account-org fallback).
 * More than one (pre-650 dirty data) → fail closed to the fallback rather than
 * guess a workspace. Never throws — every path degrades to the fallback.
 */
async function federateWorkspaceLink(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  connection: IntegrationConnection,
  repo: { externalId: string; fullName: string },
): Promise<RepoLink | null> {
  try {
    const links = await ctx.state.listActiveWorkspaceLinksForProviderRepo(
      "github",
      repo.externalId,
    );
    if (!links.ok || links.value.length === 0) return null;

    const usable: WorkspaceLink[] = [];
    for (const candidate of links.value) {
      if (await workspaceLinkUsableByConnection(ctx, connection, candidate)) {
        usable.push(candidate);
      }
    }
    if (usable.length === 0) return null;
    if (usable.length > 1) {
      // Ambiguous double-claim (pre-650 data the dedupe has not reached yet):
      // never guess a workspace — fall back to the account org and surface the
      // ambiguity for operators.
      console.warn(
        JSON.stringify({
          level: "warn",
          scope: "integrations.drain.federation",
          reason: "ambiguous_workspace_links",
          deliveryId: delivery.id,
          repoExternalId: repo.externalId,
          connectionId: connection.id,
          linkCount: usable.length,
        }),
      );
      return null;
    }

    const workspace = usable[0]!;
    const created = await ctx.repo.createRepoLink({
      id: generateUuid(),
      orgId: asUuid(workspace.orgId),
      projectId: asUuid(workspace.projectId),
      connectionId: asUuid(connection.id),
      repoExternalId: repo.externalId,
      repoFullName: repo.fullName,
      defaultBranch: null,
      branchEnvMap: {},
      createdBy: null,
    });
    if (created.ok) return created.value;
    if (created.error.kind === "conflict") {
      // Lost the IT2 single-claim race (uq_integrations_repo_claim) — re-read
      // and route to the winner.
      const winner = await ctx.repo.findActiveRepoLinkByConnectionAndRepo(
        asUuid(connection.id),
        repo.externalId,
      );
      return winner.ok ? winner.value : null;
    }
    return null;
  } catch {
    // Federation is best-effort routing enrichment; the account-org fallback
    // preserves the drain's never-throw failure discipline.
    return null;
  }
}

/** Branch the event refers to, for environment resolution. */
function eventBranch(payload: Record<string, unknown>): string | null {
  if (typeof payload.branch === "string" && payload.branch) return payload.branch;
  // Pull requests resolve against their TARGET branch.
  if (typeof payload.targetBranch === "string" && payload.targetBranch) return payload.targetBranch;
  return null;
}

function resolveEnvironment(
  branchEnvMap: Record<string, string>,
  payload: Record<string, unknown>,
): string | null {
  const branch = eventBranch(payload);
  if (!branch) return null;
  return branchEnvMap[branch] ?? null;
}

/**
 * Emit the normalized event once per target (org-scoped, or per linked
 * project) and mark the delivery `emitted` — all in one transaction when the
 * executor supports it.
 */
async function emitScmEvents(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  connection: IntegrationConnection,
  normalized: { type: ScmEventType; payload: Record<string, unknown>; repo: { externalId: string; fullName: string } },
  targets: Array<{ orgId: string; projectId: string | null; environment: string | null }>,
): Promise<DeliveryOutcome> {
  const firstEventId = generateUuid();
  // orun-work v2 (WP2): the same normalized delivery projects into the work
  // plane's observation log — one ingester, one transaction, dedupe-idempotent
  // (a redelivered webhook folds identically). Task keys parse from the
  // branch/PR title; the affected set arrives via the orun/CI producer later.
  const workDrafts = workObservationsFromScm(normalized.type, normalized.payload, ctx.now().toISOString());
  const workOrgIds = [...new Set(targets.map((t) => t.orgId))];
  const build = async (events: EventsRepository, repo: IntegrationsRepository, tx: SqlExecutor): Promise<void> => {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      const appended = await events.appendEventWithAudit({
        event: {
          id: i === 0 ? firstEventId : generateUuid(),
          type: normalized.type,
          version: 1,
          source: "integrations-worker",
          occurredAt: ctx.now(),
          actorType: "system",
          actorId: "integrations-worker",
          orgId: target.orgId,
          projectId: target.projectId,
          subjectKind: "repository",
          subjectId: normalized.repo.externalId,
          subjectName: normalized.repo.fullName,
          requestId: inboundDeliveryPublicId(delivery.id),
          payload: {
            ...normalized.payload,
            projectId: target.projectId ? projectPublicId(target.projectId) : null,
            environment: target.environment,
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `${normalized.type} on ${normalized.repo.fullName}`,
          projectId: target.projectId,
        },
      });
      if (!appended.ok) throw new Error("event_append_failed");
    }
    for (const orgId of workOrgIds) {
      for (const draft of workDrafts) {
        await insertWorkObservation(tx, orgId, { ...draft, workspace: orgId });
      }
    }
    const marked = await repo.markInboundDelivery(asUuid(delivery.id), {
      status: "emitted",
      orgId: asUuid(connection.orgId),
      connectionId: asUuid(connection.id),
      emittedEventId: asUuid(firstEventId),
      failureReason: null,
    });
    if (!marked.ok) throw new Error("delivery_mark_failed");
  };

  try {
    const executor = ctx.executor as SqlExecutor & {
      transaction?: <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
    };
    if (typeof executor.transaction === "function") {
      await executor.transaction(async (tx) => {
        await build(createEventsRepository(tx), createIntegrationsRepository(tx), tx);
      });
    } else {
      await build(ctx.events, ctx.repo, ctx.executor);
    }
    return { kind: "emitted", eventType: normalized.type };
  } catch {
    return markRetryOrFail(ctx, delivery, "emit_failed");
  }
}

/** One cron tick: claim due inbox rows oldest-first and process each. */
export async function drainInboundDeliveries(
  executor: SqlExecutor,
  env: Env,
  opts?: { batchSize?: number; now?: () => Date },
): Promise<DrainSummary> {
  const ctx: ProcessCtx = {
    executor,
    repo: createIntegrationsRepository(executor),
    events: createEventsRepository(executor),
    state: createStateRepository(executor),
    membership: createMembershipRepository(executor),
    env,
    now: opts?.now ?? (() => new Date()),
  };
  const summary: DrainSummary = { processed: 0, emitted: 0, skipped: 0, retried: 0, failed: 0 };

  const due = await ctx.repo.listDueInboundDeliveries(opts?.batchSize ?? DEFAULT_BATCH_SIZE);
  if (!due.ok) return summary;

  for (const delivery of due.value) {
    summary.processed += 1;
    try {
      const outcome = await processDelivery(ctx, delivery);
      if (outcome.kind === "emitted") summary.emitted += 1;
      else if (outcome.kind === "skipped") summary.skipped += 1;
      else if (outcome.kind === "retried") summary.retried += 1;
      else summary.failed += 1;
    } catch {
      const outcome = await markRetryOrFail(ctx, delivery, "processing_error");
      if (outcome.kind === "failed") summary.failed += 1;
      else summary.retried += 1;
    }
  }

  return summary;
}
