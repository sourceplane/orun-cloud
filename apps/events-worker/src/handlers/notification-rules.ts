import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  EventsRepository,
  NotificationRulesRepository,
  RuleAttributeFilter,
  StoredEvent,
  StoredNotificationRule,
  StoredRuleTarget,
} from "@saas/db/events";
import {
  createEventsRepository,
  createNotificationRulesRepository,
} from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createTimings } from "@saas/contracts/timing";
import {
  EVENT_SEVERITIES,
  EVENT_TYPE_PATTERN,
  type EventSeverity,
} from "@saas/contracts/event-catalog";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { checkBillingEntitlement } from "../billing-client.js";
import { errorResponse, validationError, withTimings } from "../http.js";
import { toPublicScopeId, generateEventId, generateRuleId, generateRuleTargetId } from "../ids.js";
import { hexToUuid, uuidToHex, uuidFromPublicId } from "@saas/db/ids";
import { ruleMatchesEvent } from "../lanes/rule-match.js";

export const FEATURE_EVENT_ROUTING = "feature.event_routing";
export const LIMIT_NOTIFICATION_RULES = "limit.notification_rules";

const NAME_RE = /^[\w][\w .:/-]{0,118}[\w)]?$/;
const GLOB_RE = /^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$/;
const FILTER_PATH_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const SOURCE_RE = /^[a-z0-9-]{1,64}$/;
const RULE_ID_RE = /^rule_[0-9a-f]{32}$/;
const TARGET_ID_RE = /^rtgt_[0-9a-f]{32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface NotificationRulesDeps {
  rulesRepo?: NotificationRulesRepository;
  eventsRepo?: EventsRepository;
}

interface PublicRuleTarget {
  id: string;
  kind: string;
  ref: string;
  enabled: boolean;
  createdAt: string;
}

function toPublicTarget(target: StoredRuleTarget): PublicRuleTarget {
  return {
    id: target.id,
    kind: target.targetKind,
    ref: target.targetRef,
    enabled: target.enabled,
    createdAt: target.createdAt.toISOString(),
  };
}

function toPublicRule(rule: StoredNotificationRule, targets?: StoredRuleTarget[]) {
  return {
    id: rule.id,
    orgId: toPublicScopeId("org_", rule.orgId) ?? rule.orgId,
    projectId: toPublicScopeId("prj_", rule.projectId),
    name: rule.name,
    status: rule.status,
    eventTypes: rule.eventTypes,
    minSeverity: rule.minSeverity,
    sources: rule.sources,
    attributeFilters: rule.attributeFilters,
    throttleWindowSeconds: rule.throttleWindowSeconds,
    throttleMax: rule.throttleMax,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    ...(targets ? { targets: targets.map(toPublicTarget) } : {}),
  };
}

function bindingsMissing(env: Env): boolean {
  return !env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidatedRuleBody {
  name: string;
  projectId: string | null;
  eventTypes: string[];
  minSeverity: EventSeverity;
  sources: string[] | null;
  attributeFilters: RuleAttributeFilter[] | null;
  throttleWindowSeconds: number;
  throttleMax: number;
  targets: Array<{ kind: "email" | "slack_channel"; ref: string }>;
}

type RuleBodyResult =
  | { ok: true; value: ValidatedRuleBody }
  | { ok: false; errors: Record<string, string[]> };

function parseProjectPublicId(value: string): string | null {
  if (!value.startsWith("prj_")) return null;
  return hexToUuid(value.slice(4));
}

function validateRuleBody(body: unknown, partial: boolean): RuleBodyResult {
  const errors: Record<string, string[]> = {};
  if (!body || typeof body !== "object") {
    return { ok: false, errors: { _root: ["Body must be a JSON object"] } };
  }
  const b = body as Record<string, unknown>;
  const value: ValidatedRuleBody = {
    name: "",
    projectId: null,
    eventTypes: [],
    minSeverity: "info",
    sources: null,
    attributeFilters: null,
    throttleWindowSeconds: 300,
    throttleMax: 10,
    targets: [],
  };

  if (b.name !== undefined || !partial) {
    if (typeof b.name !== "string" || !NAME_RE.test(b.name)) {
      errors.name = ["Required: 1-120 chars (letters, numbers, spaces, . : / _ -)"];
    } else {
      value.name = b.name;
    }
  }

  if (b.projectId !== undefined && b.projectId !== null) {
    if (typeof b.projectId !== "string") {
      errors.projectId = ["Must be a project public id (prj_...)"];
    } else {
      const uuid = parseProjectPublicId(b.projectId);
      if (!uuid) errors.projectId = ["Must be a project public id (prj_...)"];
      else value.projectId = uuid;
    }
  }

  if (b.eventTypes !== undefined || !partial) {
    if (!Array.isArray(b.eventTypes) || b.eventTypes.length === 0 || b.eventTypes.length > 20) {
      errors.eventTypes = ["Required: 1-20 event type globs"];
    } else if (!b.eventTypes.every((g) => typeof g === "string" && GLOB_RE.test(g))) {
      errors.eventTypes = ['Each glob must be "*", an exact type, or a "prefix.*" pattern'];
    } else {
      value.eventTypes = b.eventTypes as string[];
    }
  }

  if (b.minSeverity !== undefined) {
    if (
      typeof b.minSeverity !== "string" ||
      !(EVENT_SEVERITIES as readonly string[]).includes(b.minSeverity)
    ) {
      errors.minSeverity = [`Must be one of ${EVENT_SEVERITIES.join(", ")}`];
    } else {
      value.minSeverity = b.minSeverity as EventSeverity;
    }
  }

  if (b.sources !== undefined && b.sources !== null) {
    if (
      !Array.isArray(b.sources) ||
      b.sources.length > 10 ||
      !b.sources.every((s) => typeof s === "string" && SOURCE_RE.test(s))
    ) {
      errors.sources = ["Up to 10 source names (lowercase, digits, hyphens)"];
    } else {
      value.sources = b.sources as string[];
    }
  }

  if (b.attributeFilters !== undefined && b.attributeFilters !== null) {
    if (!Array.isArray(b.attributeFilters) || b.attributeFilters.length > 10) {
      errors.attributeFilters = ["Up to 10 filters"];
    } else {
      const filters: RuleAttributeFilter[] = [];
      for (const [i, raw] of (b.attributeFilters as unknown[]).entries()) {
        if (!raw || typeof raw !== "object") {
          errors[`attributeFilters.${i}`] = ["Must be an object {path, op, value}"];
          continue;
        }
        const f = raw as Record<string, unknown>;
        if (typeof f.path !== "string" || f.path.length > 128 || !FILTER_PATH_RE.test(f.path)) {
          errors[`attributeFilters.${i}.path`] = ["Dotted payload path (letters, digits, _)"];
          continue;
        }
        if (f.op !== "eq" && f.op !== "neq" && f.op !== "in") {
          errors[`attributeFilters.${i}.op`] = ["Must be eq, neq, or in"];
          continue;
        }
        const isScalar = (v: unknown) =>
          typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null;
        if (f.op === "in") {
          if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > 20 || !f.value.every(isScalar)) {
            errors[`attributeFilters.${i}.value`] = ["Must be an array of up to 20 scalars"];
            continue;
          }
        } else if (!isScalar(f.value)) {
          errors[`attributeFilters.${i}.value`] = ["Must be a scalar"];
          continue;
        }
        filters.push({ path: f.path, op: f.op, value: f.value });
      }
      value.attributeFilters = filters;
    }
  }

  if (b.throttleWindowSeconds !== undefined) {
    if (
      typeof b.throttleWindowSeconds !== "number" ||
      !Number.isInteger(b.throttleWindowSeconds) ||
      b.throttleWindowSeconds < 0 ||
      b.throttleWindowSeconds > 86400
    ) {
      errors.throttleWindowSeconds = ["Integer seconds, 0-86400"];
    } else {
      value.throttleWindowSeconds = b.throttleWindowSeconds;
    }
  }
  if (b.throttleMax !== undefined) {
    if (
      typeof b.throttleMax !== "number" ||
      !Number.isInteger(b.throttleMax) ||
      b.throttleMax < 1 ||
      b.throttleMax > 1000
    ) {
      errors.throttleMax = ["Integer, 1-1000"];
    } else {
      value.throttleMax = b.throttleMax;
    }
  }

  if (b.targets !== undefined) {
    if (!Array.isArray(b.targets) || b.targets.length > 10) {
      errors.targets = ["Up to 10 targets"];
    } else {
      for (const [i, raw] of (b.targets as unknown[]).entries()) {
        if (!raw || typeof raw !== "object") {
          errors[`targets.${i}`] = ["Must be an object {kind, ref}"];
          continue;
        }
        const t = raw as Record<string, unknown>;
        if (t.kind === "webhook_endpoint") {
          // Deferred: reusing B5's webhook_delivery_attempts (NOT NULL
          // subscription_id + subscription-keyed replay) for subscription-less
          // rule deliveries would invade the shipped delivery plane. It becomes
          // a channel-kind delivery in a later milestone.
          errors[`targets.${i}.kind`] = ['Target kind "webhook_endpoint" is not available yet'];
          continue;
        }
        if (t.kind === "slack_channel") {
          // ES3: ref is a notifications-worker channel public id (chan_<hex>).
          if (typeof t.ref !== "string" || !/^chan_[0-9a-f]{32}$/.test(t.ref)) {
            errors[`targets.${i}.ref`] = ["Must be a notification channel id (chan_...)"];
            continue;
          }
          value.targets.push({ kind: "slack_channel", ref: t.ref });
          continue;
        }
        if (t.kind !== "email") {
          errors[`targets.${i}.kind`] = ["Must be email or slack_channel"];
          continue;
        }
        if (typeof t.ref !== "string" || !EMAIL_RE.test(t.ref) || t.ref.length > 320) {
          errors[`targets.${i}.ref`] = ["Must be a valid email address"];
          continue;
        }
        value.targets.push({ kind: "email", ref: t.ref });
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Shared authorization step
// ---------------------------------------------------------------------------

async function authorizeRuleAction(
  env: Env,
  actor: ActorContext,
  orgId: string,
  action: "organization.notification_rule.read" | "organization.notification_rule.write",
  requestId: string,
  timings: ReturnType<typeof createTimings>,
): Promise<boolean> {
  const contextResult = await timings.measure("authctx", () =>
    fetchAuthorizationContext(env.MEMBERSHIP_WORKER!, actor.subjectId, actor.subjectType, orgId, requestId),
  );
  if (!contextResult.ok) return false;
  const policyResult = await timings.measure("policy", () =>
    authorizeViaPolicy(
      env.POLICY_WORKER!,
      actor.subjectId,
      actor.subjectType,
      action,
      { kind: "organization", orgId },
      contextResult.memberships,
      requestId,
    ),
  );
  return policyResult.allow;
}

async function emitRuleEvent(
  eventsRepo: EventsRepository,
  input: {
    type: "notification_rule.created" | "notification_rule.updated" | "notification_rule.deleted";
    orgId: string;
    projectId: string | null;
    ruleId: string;
    ruleName: string;
    actor: ActorContext;
    requestId: string;
    payload: Record<string, unknown>;
    description: string;
  },
): Promise<void> {
  try {
    await eventsRepo.appendEventWithAudit({
      event: {
        id: generateEventId(),
        type: input.type,
        version: 1,
        source: "events-worker",
        occurredAt: new Date(),
        actorType: input.actor.subjectType,
        actorId: input.actor.subjectId,
        orgId: input.orgId,
        projectId: input.projectId,
        subjectKind: "notification_rule",
        subjectId: input.ruleId,
        subjectName: input.ruleName,
        requestId: input.requestId,
        payload: input.payload,
      },
      audit: {
        id: generateEventId(),
        category: "events",
        description: input.description,
      },
    });
  } catch {
    // Audit sink failures must not break the mutation the caller committed.
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleListRules(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps?: NotificationRulesDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  const url = new URL(request.url);
  // Rules are a small per-org set gated by limit.notification_rules; V1
  // paging is limit-only (no cursor) and the console reads the full page.
  const limitParam = url.searchParams.get("limit");
  let limit = 50;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return validationError(requestId, { limit: ["Must be an integer between 1 and 100"] });
    }
    limit = parsed;
  }

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.rulesRepo ?? createNotificationRulesRepository(executor);
    const [allowed, result] = await Promise.all([
      authorizeRuleAction(env, actor, orgId, "organization.notification_rule.read", requestId, timings),
      timings.measure("db", () => repo.listRulesByOrg(orgId, { limit, cursor: null })),
    ]);
    if (!allowed) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "notification_rule.read", timings);
    }
    if (!result.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.read", timings);
    }
    const ruleIds = result.value.items.map((r) => r.id);
    const targetsResult = await repo.listTargetsForRules(ruleIds);
    const targetsByRule = new Map<string, StoredRuleTarget[]>();
    if (targetsResult.ok) {
      for (const target of targetsResult.value) {
        const list = targetsByRule.get(target.ruleId) ?? [];
        list.push(target);
        targetsByRule.set(target.ruleId, list);
      }
    }
    const rules = result.value.items.map((rule) => toPublicRule(rule, targetsByRule.get(rule.id) ?? []));
    endTotal();
    return withTimings(
      Response.json({ data: { notificationRules: rules }, meta: { requestId, cursor: null } }, { status: 200 }),
      requestId,
      "notification_rule.read",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.read", timings);
  } finally {
    await executor.dispose();
  }
}

export async function handleCreateRule(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps?: NotificationRulesDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.BILLING_WORKER && !deps?.rulesRepo) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { _root: ["Body must be valid JSON"] });
  }
  const validated = validateRuleBody(body, false);
  if (!validated.ok) return validationError(requestId, validated.errors);

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.rulesRepo ?? createNotificationRulesRepository(executor);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor);

    const allowed = await authorizeRuleAction(env, actor, orgId, "organization.notification_rule.write", requestId, timings);
    if (!allowed) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "notification_rule.write", timings);
    }

    // Entitlement gate: feature flag, then quantity limit (412 + upgrade UX).
    if (env.BILLING_WORKER) {
      const orgPublicId = `org_${uuidToHex(orgId)}`;
      const feature = await timings.measure("entitlement", () =>
        checkBillingEntitlement(env.BILLING_WORKER!, orgPublicId, FEATURE_EVENT_ROUTING, requestId),
      );
      if (feature.kind === "service_error") {
        endTotal();
        return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.write", timings);
      }
      if (!feature.decision.allowed) {
        endTotal();
        return withTimings(
          errorResponse("precondition_failed", "Event routing is not available on the current plan", 412, requestId, {
            reason: ("reason" in feature.decision ? feature.decision.reason : undefined) ?? "not_configured",
            entitlementKey: FEATURE_EVENT_ROUTING,
          }),
          requestId,
          "notification_rule.write",
          timings,
        );
      }
      const limitCheck = await checkBillingEntitlement(env.BILLING_WORKER!, orgPublicId, LIMIT_NOTIFICATION_RULES, requestId);
      if (limitCheck.kind === "service_error") {
        endTotal();
        return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.write", timings);
      }
      if (limitCheck.decision.allowed && limitCheck.decision.limitValue !== null && limitCheck.decision.limitValue !== undefined) {
        const countResult = await repo.countRulesByOrg(orgId);
        if (!countResult.ok) {
          endTotal();
          return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.write", timings);
        }
        if (countResult.value >= limitCheck.decision.limitValue) {
          endTotal();
          return withTimings(
            errorResponse("precondition_failed", "Notification rule limit reached for the current plan", 412, requestId, {
              reason: "limit_reached",
              entitlementKey: LIMIT_NOTIFICATION_RULES,
              limit: limitCheck.decision.limitValue,
            }),
            requestId,
            "notification_rule.write",
            timings,
          );
        }
      }
    }

    // created_by stores the raw actor uuid, never the public usr_<hex> form
    // (house id-hygiene rule shared with config-worker's created_by columns).
    const createdByUuid = uuidFromPublicId(actor.subjectId) ?? actor.subjectId;

    const ruleId = generateRuleId();
    const created = await timings.measure("db", () =>
      repo.createRule({
        id: ruleId,
        orgId,
        projectId: validated.value.projectId,
        name: validated.value.name,
        eventTypes: validated.value.eventTypes,
        minSeverity: validated.value.minSeverity,
        sources: validated.value.sources,
        attributeFilters: validated.value.attributeFilters,
        throttleWindowSeconds: validated.value.throttleWindowSeconds,
        throttleMax: validated.value.throttleMax,
        createdBy: createdByUuid,
      }),
    );
    if (!created.ok) {
      endTotal();
      if (created.error.kind === "conflict") {
        return withTimings(errorResponse("conflict", "A rule with this name already exists", 409, requestId), requestId, "notification_rule.write", timings);
      }
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.write", timings);
    }

    const targets: StoredRuleTarget[] = [];
    for (const target of validated.value.targets) {
      const added = await repo.addTarget({
        id: generateRuleTargetId(),
        ruleId,
        orgId,
        targetKind: target.kind,
        targetRef: target.ref,
      });
      if (added.ok) targets.push(added.value);
    }

    await emitRuleEvent(eventsRepo, {
      type: "notification_rule.created",
      orgId,
      projectId: validated.value.projectId,
      ruleId,
      ruleName: validated.value.name,
      actor,
      requestId,
      payload: {
        eventTypes: validated.value.eventTypes,
        minSeverity: validated.value.minSeverity,
        targetCount: targets.length,
      },
      description: `Notification rule created: ${validated.value.name}`,
    });

    endTotal();
    return withTimings(
      Response.json({ data: { notificationRule: toPublicRule(created.value, targets) }, meta: { requestId } }, { status: 201 }),
      requestId,
      "notification_rule.write",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.write", timings);
  } finally {
    await executor.dispose();
  }
}

export async function handleGetRule(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  ruleId: string,
  deps?: NotificationRulesDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.rulesRepo ?? createNotificationRulesRepository(executor);
    const [allowed, result] = await Promise.all([
      authorizeRuleAction(env, actor, orgId, "organization.notification_rule.read", requestId, timings),
      timings.measure("db", () => repo.getRule(orgId, ruleId)),
    ]);
    if (!allowed || !result.ok || !result.value) {
      endTotal();
      const status = allowed && result.ok && !result.value ? 404 : allowed && !result.ok ? 503 : 404;
      const code = status === 503 ? "internal_error" : "not_found";
      return withTimings(errorResponse(code, status === 503 ? "Service unavailable" : "Not found", status, requestId), requestId, "notification_rule.read", timings);
    }
    const targets = await repo.listTargetsByRule(ruleId);
    endTotal();
    return withTimings(
      Response.json(
        { data: { notificationRule: toPublicRule(result.value, targets.ok ? targets.value : []) }, meta: { requestId } },
        { status: 200 },
      ),
      requestId,
      "notification_rule.read",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.read", timings);
  } finally {
    await executor.dispose();
  }
}

export async function handleUpdateRule(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  ruleId: string,
  deps?: NotificationRulesDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { _root: ["Body must be valid JSON"] });
  }
  const b = body as Record<string, unknown>;
  const validated = validateRuleBody(body, true);
  if (!validated.ok) return validationError(requestId, validated.errors);
  if (b.status !== undefined && b.status !== "enabled" && b.status !== "disabled") {
    return validationError(requestId, { status: ["Must be enabled or disabled"] });
  }

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.rulesRepo ?? createNotificationRulesRepository(executor);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor);

    const allowed = await authorizeRuleAction(env, actor, orgId, "organization.notification_rule.write", requestId, timings);
    if (!allowed) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "notification_rule.write", timings);
    }

    const patch: Parameters<NotificationRulesRepository["updateRule"]>[2] = {};
    if (b.name !== undefined) patch.name = validated.value.name;
    if (b.status !== undefined) patch.status = b.status as "enabled" | "disabled";
    if (b.projectId !== undefined) patch.projectId = validated.value.projectId;
    if (b.eventTypes !== undefined) patch.eventTypes = validated.value.eventTypes;
    if (b.minSeverity !== undefined) patch.minSeverity = validated.value.minSeverity;
    if (b.sources !== undefined) patch.sources = validated.value.sources;
    if (b.attributeFilters !== undefined) patch.attributeFilters = validated.value.attributeFilters;
    if (b.throttleWindowSeconds !== undefined) patch.throttleWindowSeconds = validated.value.throttleWindowSeconds;
    if (b.throttleMax !== undefined) patch.throttleMax = validated.value.throttleMax;

    const updated = await timings.measure("db", () => repo.updateRule(orgId, ruleId, patch));
    if (!updated.ok) {
      endTotal();
      if (updated.error.kind === "conflict") {
        return withTimings(errorResponse("conflict", "A rule with this name already exists", 409, requestId), requestId, "notification_rule.write", timings);
      }
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.write", timings);
    }
    if (!updated.value) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "notification_rule.write", timings);
    }

    await emitRuleEvent(eventsRepo, {
      type: "notification_rule.updated",
      orgId,
      projectId: updated.value.projectId,
      ruleId,
      ruleName: updated.value.name,
      actor,
      requestId,
      payload: { updatedFields: Object.keys(patch) },
      description: `Notification rule updated: ${updated.value.name}`,
    });

    const targets = await repo.listTargetsByRule(ruleId);
    endTotal();
    return withTimings(
      Response.json(
        { data: { notificationRule: toPublicRule(updated.value, targets.ok ? targets.value : []) }, meta: { requestId } },
        { status: 200 },
      ),
      requestId,
      "notification_rule.write",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.write", timings);
  } finally {
    await executor.dispose();
  }
}

export async function handleDeleteRule(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  ruleId: string,
  deps?: NotificationRulesDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.rulesRepo ?? createNotificationRulesRepository(executor);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor);

    const allowed = await authorizeRuleAction(env, actor, orgId, "organization.notification_rule.write", requestId, timings);
    if (!allowed) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "notification_rule.write", timings);
    }

    const existing = await repo.getRule(orgId, ruleId);
    if (!existing.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.write", timings);
    }
    if (!existing.value) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "notification_rule.write", timings);
    }

    const deleted = await timings.measure("db", () => repo.deleteRule(orgId, ruleId));
    if (!deleted.ok || !deleted.value) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.write", timings);
    }

    await emitRuleEvent(eventsRepo, {
      type: "notification_rule.deleted",
      orgId,
      projectId: existing.value.projectId,
      ruleId,
      ruleName: existing.value.name,
      actor,
      requestId,
      payload: {},
      description: `Notification rule deleted: ${existing.value.name}`,
    });

    endTotal();
    return withTimings(
      Response.json({ data: { deleted: true }, meta: { requestId } }, { status: 200 }),
      requestId,
      "notification_rule.write",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.write", timings);
  } finally {
    await executor.dispose();
  }
}

/**
 * POST .../notification-rules/{ruleId}/test — synthesize an event from the
 * request body and report whether this rule would match and which targets
 * would receive it. Never sends anything.
 */
export async function handleTestRule(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  ruleId: string,
  deps?: NotificationRulesDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { _root: ["Body must be valid JSON"] });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.type !== "string" || !EVENT_TYPE_PATTERN.test(b.type)) {
    return validationError(requestId, { type: ["Required: a dotted event type"] });
  }
  const payload =
    b.payload && typeof b.payload === "object" && !Array.isArray(b.payload)
      ? (b.payload as Record<string, unknown>)
      : {};
  if (typeof b.severity === "string") payload["severity"] = b.severity;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.rulesRepo ?? createNotificationRulesRepository(executor);
    const allowed = await authorizeRuleAction(env, actor, orgId, "organization.notification_rule.read", requestId, timings);
    if (!allowed) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "notification_rule.read", timings);
    }
    const ruleResult = await timings.measure("db", () => repo.getRule(orgId, ruleId));
    if (!ruleResult.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.read", timings);
    }
    if (!ruleResult.value) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "notification_rule.read", timings);
    }

    const synthetic: StoredEvent = {
      id: "evt_test",
      type: b.type,
      version: 1,
      source: typeof b.source === "string" ? b.source : "test",
      occurredAt: new Date(),
      actorType: "system",
      actorId: "test",
      actorSessionId: null,
      actorIp: null,
      orgId,
      projectId:
        typeof b.projectId === "string" && b.projectId.startsWith("prj_")
          ? parseProjectPublicId(b.projectId)
          : null,
      environmentId: null,
      subjectKind: "test",
      subjectId: "test",
      subjectName: null,
      requestId,
      correlationId: null,
      causationId: null,
      idempotencyKey: null,
      payload,
      redactPaths: [],
      createdAt: new Date(),
    };

    const matched = ruleMatchesEvent(ruleResult.value, synthetic);
    const targetsResult = await repo.listTargetsByRule(ruleId);
    const matchedTargets =
      matched && targetsResult.ok
        ? targetsResult.value.filter((t) => t.enabled).map(toPublicTarget)
        : [];

    endTotal();
    return withTimings(
      Response.json(
        {
          data: {
            matched,
            ruleStatus: ruleResult.value.status,
            matchedTargets,
          },
          meta: { requestId },
        },
        { status: 200 },
      ),
      requestId,
      "notification_rule.read",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "notification_rule.read", timings);
  } finally {
    await executor.dispose();
  }
}

export { RULE_ID_RE, TARGET_ID_RE };
