import type { Env } from "../env.js";
import type { InternalActor } from "../router.js";
import {
  createNotificationChannelsRepository,
  type NotificationChannelsRepository,
  type StoredNotificationChannel,
} from "@saas/db/notifications";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { uuidFromPublicId, asUuid } from "@saas/db/ids";
import { createEncryptionAdapter } from "../encryption.js";
import { createSlackWebhookProvider } from "../providers/slack-webhook.js";
import { createSlackAppProvider } from "../providers/slack-app.js";
import { fetchSlackDeliveryCredentials } from "../services/slack-credentials.js";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { checkBillingEntitlement } from "../billing-client.js";
import { emitEvent } from "../events-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { channelPublicId, generateChannelId, orgPublicId, parseChannelPublicId, parseOrgIdInput } from "../ids.js";

export const FEATURE_NOTIFICATIONS_SLACK = "feature.notifications.slack";
export const LIMIT_NOTIFICATION_CHANNELS = "limit.notification_channels";

// Display label. Allows a leading (and inline) `#` so a Slack-style channel
// label like "#alerts" validates — the console auto-fills the notification
// channel name as `#<slack-channel>` when a channel is picked, and users
// naturally type the `#` form.
const NAME_RE = /^[#\w][\w #.:/-]{0,118}[\w)]?$/;
const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;
// slack_app references (IH2): the public connection id + Slack channel id the
// picker returned. Shapes only — usability of the connection is re-verified
// against integrations-worker at create time AND on every send.
const CONNECTION_ID_RE = /^int_[0-9a-f]{32}$/;
const SLACK_CHANNEL_ID_RE = /^[CDG][A-Z0-9]{5,63}$/;

export interface ChannelsHandlerDeps {
  channelsRepo?: NotificationChannelsRepository;
  emit?: typeof emitEvent;
  fetchImpl?: typeof fetch;
}

interface PublicChannel {
  id: string;
  orgId: string;
  kind: string;
  name: string;
  status: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPublicChannel(c: StoredNotificationChannel): PublicChannel {
  return {
    id: channelPublicId(c.id),
    orgId: orgPublicId(c.orgId),
    kind: c.kind,
    name: c.name,
    status: c.status,
    lastVerifiedAt: c.lastVerifiedAt ? c.lastVerifiedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function bindingsMissing(env: Env): boolean {
  return !env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER;
}

async function authorize(
  env: Env,
  actor: InternalActor,
  orgUuid: string,
  action: "organization.notification_channel.read" | "organization.notification_channel.write",
  requestId: string,
): Promise<boolean> {
  const ctx = await fetchAuthorizationContext(env.MEMBERSHIP_WORKER!, actor.subjectId, actor.subjectType, orgUuid, requestId);
  if (!ctx.ok) return false;
  const decision = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    action,
    { kind: "organization", orgId: orgUuid },
    ctx.memberships,
    requestId,
  );
  return decision.allow;
}

export async function emitChannelEvent(
  env: Env,
  emit: typeof emitEvent,
  input: {
    type:
      | "notification_channel.created"
      | "notification_channel.updated"
      | "notification_channel.deleted"
      | "notification_channel.verified";
    orgUuid: string;
    channel: StoredNotificationChannel;
    actor: InternalActor;
    requestId: string;
    description: string;
  },
): Promise<void> {
  await emit(env, {
    type: input.type,
    notificationId: channelPublicId(input.channel.id),
    orgId: orgPublicId(input.orgUuid),
    subjectKind: "notification_channel",
    subjectId: channelPublicId(input.channel.id),
    actorType: input.actor.subjectType,
    actorId: input.actor.subjectId,
    requestId: input.requestId,
    correlationId: null,
    category: "notifications",
    description: input.description,
    // Redaction-safe metadata only — NEVER the ciphertext or the URL.
    payload: { kind: input.channel.kind, name: input.channel.name, status: input.channel.status },
    occurredAt: new Date(),
  });
}

function repoFor(env: Env, deps: ChannelsHandlerDeps): {
  repo: NotificationChannelsRepository;
  dispose: () => Promise<void>;
} {
  if (deps.channelsRepo) return { repo: deps.channelsRepo, dispose: async () => {} };
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  return { repo: createNotificationChannelsRepository(executor), dispose: () => executor.dispose() };
}

export async function handleListChannels(
  env: Env,
  requestId: string,
  actor: InternalActor,
  orgUuidRaw: string,
  deps: ChannelsHandlerDeps = {},
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const orgUuid = parseOrgIdInput(orgUuidRaw);
  if (!orgUuid) return errorResponse("not_found", "Not found", 404, requestId);
  if (!(await authorize(env, actor, orgUuid, "organization.notification_channel.read", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const { repo, dispose } = repoFor(env, deps);
  try {
    const result = await repo.listChannels(asUuid(orgUuid));
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse({ notificationChannels: result.value.map(toPublicChannel) }, requestId);
  } finally {
    await dispose();
  }
}

export async function handleCreateChannel(
  request: Request,
  env: Env,
  requestId: string,
  actor: InternalActor,
  orgUuidRaw: string,
  deps: ChannelsHandlerDeps = {},
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.SECRET_ENCRYPTION_KEY) {
    return errorResponse("internal_error", "Channel encryption not configured", 503, requestId);
  }
  const orgUuid = parseOrgIdInput(orgUuidRaw);
  if (!orgUuid) return errorResponse("not_found", "Not found", 404, requestId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { _root: ["Body must be valid JSON"] });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string[]> = {};
  if (typeof b.name !== "string" || !NAME_RE.test(b.name)) {
    errors.name = ["Required: 1-120 chars"];
  }
  const kindRaw = b.kind === undefined ? "slack_incoming_webhook" : b.kind;
  if (kindRaw !== "slack_incoming_webhook" && kindRaw !== "slack_app") {
    errors.kind = ['Must be "slack_incoming_webhook" or "slack_app"'];
  }
  const kind = (kindRaw === "slack_app" ? "slack_app" : "slack_incoming_webhook") as
    | "slack_app"
    | "slack_incoming_webhook";
  if (kind === "slack_app") {
    if (typeof b.connectionId !== "string" || !CONNECTION_ID_RE.test(b.connectionId)) {
      errors.connectionId = ["Required: the Slack connection id (int_…)"];
    }
    if (typeof b.channelExternalId !== "string" || !SLACK_CHANNEL_ID_RE.test(b.channelExternalId)) {
      errors.channelExternalId = ["Required: a Slack channel id (e.g. C0123ABCDEF)"];
    }
    if (typeof b.channelName !== "string" || !NAME_RE.test(b.channelName)) {
      errors.channelName = ["Required: 1-120 chars"];
    }
  } else if (typeof b.webhookUrl !== "string" || !SLACK_WEBHOOK_RE.test(b.webhookUrl)) {
    errors.webhookUrl = ["Must be a Slack incoming-webhook URL (https://hooks.slack.com/services/...)"];
  }
  if (Object.keys(errors).length > 0) return validationError(requestId, errors);

  if (!(await authorize(env, actor, orgUuid, "organization.notification_channel.write", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const { repo, dispose } = repoFor(env, deps);
  try {
    // Entitlement gate: feature flag then channel-count limit.
    if (env.BILLING_WORKER) {
      const pub = orgPublicId(orgUuid);
      const feature = await checkBillingEntitlement(env.BILLING_WORKER, pub, FEATURE_NOTIFICATIONS_SLACK, requestId);
      if (feature.kind === "service_error") return errorResponse("internal_error", "Service unavailable", 503, requestId);
      if (!feature.decision.allowed) {
        return errorResponse("precondition_failed", "Slack channels are not available on the current plan", 412, requestId, {
          reason: ("reason" in feature.decision ? feature.decision.reason : undefined) ?? "not_configured",
          entitlementKey: FEATURE_NOTIFICATIONS_SLACK,
        });
      }
      const limit = await checkBillingEntitlement(env.BILLING_WORKER, pub, LIMIT_NOTIFICATION_CHANNELS, requestId);
      if (limit.kind === "service_error") return errorResponse("internal_error", "Service unavailable", 503, requestId);
      if (limit.decision.allowed && limit.decision.limitValue !== null && limit.decision.limitValue !== undefined) {
        const count = await repo.countChannels(asUuid(orgUuid));
        if (!count.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
        if (count.value >= limit.decision.limitValue) {
          return errorResponse("precondition_failed", "Notification channel limit reached for the current plan", 412, requestId, {
            reason: "limit_reached",
            entitlementKey: LIMIT_NOTIFICATION_CHANNELS,
            limit: limit.decision.limitValue,
          });
        }
      }
    }

    if (kind === "slack_app") {
      // The reference must point at a connection THIS org may use (own or
      // account-shared with admission) — verified against integrations-worker
      // custody now, and again on every send (the paste-a-foreign-id hole).
      if (!env.INTEGRATIONS_WORKER) {
        return errorResponse("precondition_failed", "Slack workspace channels are not available in this environment", 412, requestId, {
          reason: "not_configured",
          gate: "integrations_binding",
        });
      }
      const usable = await fetchSlackDeliveryCredentials(
        env.INTEGRATIONS_WORKER,
        orgPublicId(orgUuid),
        b.connectionId as string,
      );
      if (!usable.ok) {
        return errorResponse("precondition_failed", "The Slack connection is not usable by this organization", 412, requestId, {
          reason: usable.reason,
        });
      }
    }

    const adapter = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
    if (!adapter) return errorResponse("internal_error", "Channel encryption not configured", 503, requestId);
    // slack_app stores a REFERENCE (connection + channel ids), never a
    // credential; the webhook kind stores its bearer URL — both encrypted.
    const plaintext =
      kind === "slack_app"
        ? JSON.stringify({
            connectionId: b.connectionId as string,
            channelExternalId: b.channelExternalId as string,
            channelName: b.channelName as string,
          })
        : (b.webhookUrl as string);
    const envelope = await adapter.encrypt(plaintext);

    const createdByUuid = uuidFromPublicId(actor.subjectId) ?? asUuid(actor.subjectId);
    const created = await repo.createChannel({
      id: generateChannelId(),
      orgId: asUuid(orgUuid),
      kind,
      name: b.name as string,
      configCiphertext: JSON.stringify(envelope),
      createdBy: createdByUuid,
    });
    if (!created.ok) {
      if (created.error.kind === "conflict") {
        return errorResponse("conflict", "A channel with this name already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    await emitChannelEvent(env, deps.emit ?? emitEvent, {
      type: "notification_channel.created",
      orgUuid,
      channel: created.value,
      actor,
      requestId,
      description: `Notification channel created: ${created.value.name}`,
    });
    return successResponse({ notificationChannel: toPublicChannel(created.value) }, requestId, 201);
  } finally {
    await dispose();
  }
}

export async function handleUpdateChannel(
  request: Request,
  env: Env,
  requestId: string,
  actor: InternalActor,
  orgUuidRaw: string,
  channelPublic: string,
  deps: ChannelsHandlerDeps = {},
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const orgUuid = parseOrgIdInput(orgUuidRaw);
  const chanUuid = parseChannelPublicId(channelPublic);
  if (!orgUuid || !chanUuid) return errorResponse("not_found", "Not found", 404, requestId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { _root: ["Body must be valid JSON"] });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string[]> = {};
  if (b.name !== undefined && (typeof b.name !== "string" || !NAME_RE.test(b.name))) {
    errors.name = ["Must be 1-120 chars"];
  }
  if (b.status !== undefined && b.status !== "active" && b.status !== "disabled") {
    errors.status = ["Must be active or disabled"];
  }
  if (b.webhookUrl !== undefined && (typeof b.webhookUrl !== "string" || !SLACK_WEBHOOK_RE.test(b.webhookUrl))) {
    errors.webhookUrl = ["Must be a Slack incoming-webhook URL"];
  }
  if (Object.keys(errors).length > 0) return validationError(requestId, errors);

  if (!(await authorize(env, actor, orgUuid, "organization.notification_channel.write", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const { repo, dispose } = repoFor(env, deps);
  try {
    const patch: Parameters<NotificationChannelsRepository["updateChannel"]>[2] = {};
    if (typeof b.name === "string") patch.name = b.name;
    if (b.status === "active" || b.status === "disabled") patch.status = b.status;
    if (typeof b.webhookUrl === "string") {
      if (!env.SECRET_ENCRYPTION_KEY) return errorResponse("internal_error", "Channel encryption not configured", 503, requestId);
      const adapter = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
      if (!adapter) return errorResponse("internal_error", "Channel encryption not configured", 503, requestId);
      patch.configCiphertext = JSON.stringify(await adapter.encrypt(b.webhookUrl));
    }
    const updated = await repo.updateChannel(asUuid(orgUuid), chanUuid, patch);
    if (!updated.ok) {
      if (updated.error.kind === "conflict") return errorResponse("conflict", "A channel with this name already exists", 409, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    if (!updated.value) return errorResponse("not_found", "Not found", 404, requestId);
    await emitChannelEvent(env, deps.emit ?? emitEvent, {
      type: "notification_channel.updated",
      orgUuid,
      channel: updated.value,
      actor,
      requestId,
      description: `Notification channel updated: ${updated.value.name}`,
    });
    return successResponse({ notificationChannel: toPublicChannel(updated.value) }, requestId);
  } finally {
    await dispose();
  }
}

export async function handleDeleteChannel(
  env: Env,
  requestId: string,
  actor: InternalActor,
  orgUuidRaw: string,
  channelPublic: string,
  deps: ChannelsHandlerDeps = {},
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const orgUuid = parseOrgIdInput(orgUuidRaw);
  const chanUuid = parseChannelPublicId(channelPublic);
  if (!orgUuid || !chanUuid) return errorResponse("not_found", "Not found", 404, requestId);
  if (!(await authorize(env, actor, orgUuid, "organization.notification_channel.write", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const { repo, dispose } = repoFor(env, deps);
  try {
    const existing = await repo.getChannel(asUuid(orgUuid), chanUuid);
    if (!existing.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    if (!existing.value) return errorResponse("not_found", "Not found", 404, requestId);
    const deleted = await repo.deleteChannel(asUuid(orgUuid), chanUuid);
    if (!deleted.ok || !deleted.value) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    await emitChannelEvent(env, deps.emit ?? emitEvent, {
      type: "notification_channel.deleted",
      orgUuid,
      channel: existing.value,
      actor,
      requestId,
      description: `Notification channel deleted: ${existing.value.name}`,
    });
    return successResponse({ deleted: true }, requestId);
  } finally {
    await dispose();
  }
}

export async function handleTestChannel(
  env: Env,
  requestId: string,
  actor: InternalActor,
  orgUuidRaw: string,
  channelPublic: string,
  deps: ChannelsHandlerDeps = {},
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.SECRET_ENCRYPTION_KEY) return errorResponse("internal_error", "Channel encryption not configured", 503, requestId);
  const orgUuid = parseOrgIdInput(orgUuidRaw);
  const chanUuid = parseChannelPublicId(channelPublic);
  if (!orgUuid || !chanUuid) return errorResponse("not_found", "Not found", 404, requestId);
  if (!(await authorize(env, actor, orgUuid, "organization.notification_channel.write", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const { repo, dispose } = repoFor(env, deps);
  try {
    const cfg = await repo.getChannelConfigForSend(asUuid(orgUuid), chanUuid);
    if (!cfg.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    if (!cfg.value) return errorResponse("not_found", "Not found", 404, requestId);
    const adapter = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
    if (!adapter) return errorResponse("internal_error", "Channel encryption not configured", 503, requestId);
    let plaintext: string;
    try {
      plaintext = await adapter.decrypt(JSON.parse(cfg.value.configCiphertext));
    } catch {
      return errorResponse("internal_error", "Channel config is unreadable", 500, requestId);
    }
    let provider;
    if (cfg.value.kind === "slack_app") {
      if (!env.INTEGRATIONS_WORKER) {
        return errorResponse("bad_gateway", "Test send failed (slack_app_not_configured)", 502, requestId);
      }
      let ref: { connectionId?: unknown; channelExternalId?: unknown };
      try {
        ref = JSON.parse(plaintext) as typeof ref;
      } catch {
        return errorResponse("internal_error", "Channel config is unreadable", 500, requestId);
      }
      if (typeof ref.connectionId !== "string" || typeof ref.channelExternalId !== "string") {
        return errorResponse("internal_error", "Channel config is unreadable", 500, requestId);
      }
      const credentials = await fetchSlackDeliveryCredentials(
        env.INTEGRATIONS_WORKER,
        orgPublicId(orgUuid),
        ref.connectionId,
      );
      if (!credentials.ok) {
        return errorResponse("bad_gateway", `Test send failed (${credentials.reason})`, 502, requestId);
      }
      provider = createSlackAppProvider({
        botToken: credentials.botToken,
        channelExternalId: ref.channelExternalId,
        channelRowId: cfg.value.id,
        consoleBaseUrl: env.CONSOLE_BASE_URL,
        fetchImpl: deps.fetchImpl,
      });
    } else {
      provider = createSlackWebhookProvider({
        webhookUrl: plaintext,
        ...(env.CONSOLE_BASE_URL ? { consoleBaseUrl: env.CONSOLE_BASE_URL } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    }
    const result = await provider.send({
      notificationId: `test-${requestId}`,
      orgId: orgUuid,
      category: "product",
      templateKey: "event.notification",
      templateData: {
        title: "Test notification from Orun Cloud",
        eventType: "notification_channel.test",
        severity: "info",
        occurredAt: new Date().toISOString(),
      },
      recipient: { channel: "slack", address: channelPublic },
    });
    if (!result.ok) {
      return errorResponse("bad_gateway", `Test send failed (${result.errorReason})`, 502, requestId);
    }
    const stamped = await repo.updateChannel(asUuid(orgUuid), chanUuid, { lastVerifiedAt: new Date() });
    if (stamped.ok && stamped.value) {
      await emitChannelEvent(env, deps.emit ?? emitEvent, {
        type: "notification_channel.verified",
        orgUuid,
        channel: stamped.value,
        actor,
        requestId,
        description: `Notification channel verified: ${stamped.value.name}`,
      });
    }
    return successResponse({ verified: true }, requestId);
  } finally {
    await dispose();
  }
}

