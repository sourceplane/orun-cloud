import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleEnqueueNotification } from "./handlers/enqueue.js";
import { handleGetNotification } from "./handlers/get-notification.js";
import { handleGetPreferences } from "./handlers/get-preferences.js";
import { handlePutPreferences } from "./handlers/put-preferences.js";
import { handleCreateSuppression } from "./handlers/create-suppression.js";
import {
  handleListChannels,
  handleCreateChannel,
  handleUpdateChannel,
  handleDeleteChannel,
  handleTestChannel,
} from "./handlers/channels.js";
import { handleSlackChannelDisable } from "./handlers/channel-freshness.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";
import { generateRequestId } from "./ids.js";
import { NOTIFICATIONS_INTERNAL_ACTOR_VALUES } from "@saas/contracts/notifications";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;
const INTERNAL_ACTOR_HEADER = "x-internal-actor";
const ACTOR_ID_HEADER = "x-actor-subject-id";
const ACTOR_TYPE_HEADER = "x-actor-subject-type";

const INTERNAL_ACTORS = new Set<string>(NOTIFICATIONS_INTERNAL_ACTOR_VALUES);

const NOTIFICATIONS_LIST_PATH = "/v1/notifications";
const PREFERENCES_PATH = "/v1/notifications/preferences";
const NOTIFICATION_ID_RE = /^\/v1\/notifications\/([^/]+)$/;
const SUPPRESS_RE = /^\/v1\/notifications\/recipients\/([^/]+)\/suppress$/;
// Channels (ES3): org-scoped so the worker can policy-check the path org
// (mirrors the events-worker notification-rules surface). Forwarded from
// api-edge with x-internal-actor=api-edge + the resolved session actor.
const CHANNELS_RE = /^\/v1\/organizations\/([^/]+)\/notification-channels$/;
const CHANNEL_RE = /^\/v1\/organizations\/([^/]+)\/notification-channels\/([^/]+)$/;
const CHANNEL_TEST_RE = /^\/v1\/organizations\/([^/]+)\/notification-channels\/([^/]+)\/test$/;
// Channel freshness on Slack archive (IH3): events-worker's messaging lane
// posts here when a linked Slack channel is archived so dependent slack_app
// channels flip to disabled. Internal-actor gated like every other route.
const SLACK_DISABLE_PATH = "/internal/notification-channels/slack-disable";

export interface InternalActor {
  subjectId: string;
  subjectType: string;
  internalCaller: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveInternalActor(request: Request): InternalActor | null {
  const internal = request.headers.get(INTERNAL_ACTOR_HEADER);
  const subjectId = request.headers.get(ACTOR_ID_HEADER);
  const subjectType = request.headers.get(ACTOR_TYPE_HEADER);
  if (!internal || !subjectId || !subjectType) return null;
  if (!INTERNAL_ACTORS.has(internal)) return null;
  return { subjectId, subjectType, internalCaller: internal };
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    // Channel freshness (IH3) — internal reaction route, never edge-forwarded.
    if (url.pathname === SLACK_DISABLE_PATH) {
      const actor = resolveInternalActor(request);
      if (!actor) return errorResponse("forbidden", "Internal service-binding required", 403, requestId);
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleSlackChannelDisable(request, env, requestId, actor);
    }

    // Channels CRUD (ES3) — org-scoped.
    const channelTestMatch = url.pathname.match(CHANNEL_TEST_RE);
    if (channelTestMatch) {
      const actor = resolveInternalActor(request);
      if (!actor) return errorResponse("forbidden", "Internal service-binding required", 403, requestId);
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleTestChannel(env, requestId, actor, channelTestMatch[1]!, channelTestMatch[2]!);
    }
    const channelMatch = url.pathname.match(CHANNEL_RE);
    if (channelMatch) {
      const actor = resolveInternalActor(request);
      if (!actor) return errorResponse("forbidden", "Internal service-binding required", 403, requestId);
      if (request.method === "PATCH") return handleUpdateChannel(request, env, requestId, actor, channelMatch[1]!, channelMatch[2]!);
      if (request.method === "DELETE") return handleDeleteChannel(env, requestId, actor, channelMatch[1]!, channelMatch[2]!);
      return methodNotAllowed(requestId);
    }
    const channelsMatch = url.pathname.match(CHANNELS_RE);
    if (channelsMatch) {
      const actor = resolveInternalActor(request);
      if (!actor) return errorResponse("forbidden", "Internal service-binding required", 403, requestId);
      if (request.method === "GET") return handleListChannels(env, requestId, actor, channelsMatch[1]!);
      if (request.method === "POST") return handleCreateChannel(request, env, requestId, actor, channelsMatch[1]!);
      return methodNotAllowed(requestId);
    }

    // Preferences: GET (list) / PUT (upsert)
    if (url.pathname === PREFERENCES_PATH) {
      const actor = resolveInternalActor(request);
      if (!actor) {
        return errorResponse("forbidden", "Internal service-binding required", 403, requestId);
      }
      if (request.method === "GET") {
        return handleGetPreferences(env, requestId, url);
      }
      if (request.method === "PUT") {
        return handlePutPreferences(request, env, requestId, actor);
      }
      return methodNotAllowed(requestId);
    }

    // Suppression: POST /v1/notifications/recipients/:recipient/suppress
    const suppressMatch = url.pathname.match(SUPPRESS_RE);
    if (suppressMatch) {
      const actor = resolveInternalActor(request);
      if (!actor) {
        return errorResponse("forbidden", "Internal service-binding required", 403, requestId);
      }
      if (request.method === "POST") {
        return handleCreateSuppression(request, env, requestId, actor, suppressMatch[1]!);
      }
      return methodNotAllowed(requestId);
    }

    // Single-notification GET — MUST be matched before /v1/notifications POST below
    // so the path-segment /preferences and /recipients aren't swallowed by it
    // (they're handled by their own routes above).
    const notifIdMatch = url.pathname.match(NOTIFICATION_ID_RE);
    if (notifIdMatch && notifIdMatch[1] !== "preferences" && notifIdMatch[1] !== "recipients") {
      const actor = resolveInternalActor(request);
      if (!actor) {
        return errorResponse("forbidden", "Internal service-binding required", 403, requestId);
      }
      if (request.method === "GET") {
        return handleGetNotification(env, requestId, notifIdMatch[1]!);
      }
      return methodNotAllowed(requestId);
    }

    if (url.pathname === NOTIFICATIONS_LIST_PATH) {
      const actor = resolveInternalActor(request);
      if (!actor) {
        return errorResponse("forbidden", "Internal service-binding required", 403, requestId);
      }
      if (request.method === "POST") {
        return handleEnqueueNotification(request, env, requestId, actor);
      }
      return methodNotAllowed(requestId);
    }

    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
