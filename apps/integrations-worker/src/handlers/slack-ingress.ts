// Slack inbound ingress (IH3, design §4.3): three allowlisted routes, one
// discipline — verify the v0 signature over RAW bytes before any parse,
// insert into the inbox (delivery_key idempotency), ack fast. The cron drain
// does the rest. The ONLY synchronous bodies any route returns are Slack's
// url_verification challenge and the slash command's ephemeral "On it…"
// (Slack's 3-second budget).

import type { Env } from "../env.js";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createIntegrationsRepository } from "@saas/db/integrations";
import type { FetchLike } from "../github-app.js";
import { errorResponse, successResponse } from "../http.js";
import { generateUuid } from "../ids.js";
import { getConfiguredProvider } from "../providers/registry.js";

const MAX_BODY_BYTES = 1 * 1024 * 1024; // Slack payloads are small; 1 MiB is generous.
const DELIVERY_KEY_RE = /^[\w.-]{1,128}$/;
const EVENT_TYPE_RE = /^[a-z_]{1,64}$/;

export interface SlackIngressDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

type VerifiedBody =
  | { ok: true; rawText: string }
  | { ok: false; response: Response };

/** Shared front half: size gate → raw bytes → v0 signature (before parse). */
async function readVerified(
  request: Request,
  env: Env,
  requestId: string,
  deps?: SlackIngressDeps,
): Promise<VerifiedBody> {
  const configured = getConfiguredProvider(env, "slack", deps?.fetchImpl);
  const inbound = configured?.provider.inbound;
  if (!inbound) {
    return {
      ok: false,
      response: errorResponse("internal_error", "Slack ingress not configured", 503, requestId),
    };
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse("payload_too_large", "Body too large", 413, requestId) };
  }

  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength === 0) {
    return { ok: false, response: errorResponse("bad_request", "Empty body", 400, requestId) };
  }
  if (rawBody.byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse("payload_too_large", "Body too large", 413, requestId) };
  }

  const verified = await inbound.verifySignature(
    rawBody,
    {
      "x-slack-signature": request.headers.get("x-slack-signature"),
      "x-slack-request-timestamp": request.headers.get("x-slack-request-timestamp"),
    },
    Date.now(),
  );
  if (!verified) {
    return {
      ok: false,
      response: errorResponse("unauthenticated", "Signature verification failed", 401, requestId),
    };
  }

  return { ok: true, rawText: new TextDecoder().decode(rawBody) };
}

/** Insert one verified delivery; duplicate keys ack idempotently. */
async function insertDelivery(
  env: Env,
  requestId: string,
  input: {
    deliveryKey: string;
    eventType: string;
    action: string | null;
    payload: Record<string, unknown>;
  },
  ackBody: Record<string, unknown>,
  deps?: SlackIngressDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB && !deps?.executor) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }
  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const inserted = await repo.insertInboundDelivery({
      id: generateUuid(),
      provider: "slack",
      deliveryKey: input.deliveryKey,
      eventType: input.eventType,
      action: input.action,
      payload: input.payload,
      signatureOk: true,
    });
    if (!inserted.ok) {
      // Slack retries events; a durable-insert failure must surface as one.
      return errorResponse("internal_error", "Failed to persist delivery", 500, requestId);
    }
    return successResponse(ackBody, requestId, inserted.value.created ? 202 : 200);
  } catch {
    return errorResponse("internal_error", "Failed to persist delivery", 500, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}

/** POST /ingress/slack/events — Events API (JSON envelope). */
export async function handleSlackEventsIngest(
  request: Request,
  env: Env,
  requestId: string,
  deps?: SlackIngressDeps,
): Promise<Response> {
  const read = await readVerified(request, env, requestId, deps);
  if (!read.ok) return read.response;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(read.rawText) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Body is not valid JSON", 400, requestId);
  }

  // Slack's endpoint handshake — answered synchronously, never persisted.
  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return Response.json({ challenge: payload.challenge }, { status: 200 });
  }

  const event = (payload.event ?? {}) as Record<string, unknown>;
  const eventType = typeof event.type === "string" ? event.type : "";
  const deliveryKey = typeof payload.event_id === "string" ? payload.event_id : "";
  if (!EVENT_TYPE_RE.test(eventType) || !DELIVERY_KEY_RE.test(deliveryKey)) {
    return errorResponse("bad_request", "Missing event type or event id", 400, requestId);
  }

  return insertDelivery(
    env,
    requestId,
    { deliveryKey, eventType, action: null, payload },
    { received: true },
    deps,
  );
}

/** Parse a form-encoded Slack body into a plain string map. */
function parseForm(rawText: string): Record<string, string> {
  const params = new URLSearchParams(rawText);
  const out: Record<string, string> = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** POST /ingress/slack/commands — slash commands (form-encoded). The sync
 *  body is the ephemeral ack; the real answer arrives via response_url from
 *  the drain (design §4.3: verify → insert → ack, everything else async). */
export async function handleSlackCommandsIngest(
  request: Request,
  env: Env,
  requestId: string,
  deps?: SlackIngressDeps,
): Promise<Response> {
  const read = await readVerified(request, env, requestId, deps);
  if (!read.ok) return read.response;

  const fields = parseForm(read.rawText);
  const triggerId = fields.trigger_id ?? "";
  if (!DELIVERY_KEY_RE.test(triggerId)) {
    return errorResponse("bad_request", "Missing trigger id", 400, requestId);
  }

  const inserted = await insertDelivery(
    env,
    requestId,
    {
      deliveryKey: `cmd.${triggerId}`,
      eventType: "slash_command",
      action: fields.command ?? null,
      payload: fields,
    },
    { received: true },
    deps,
  );
  if (!inserted.ok) return inserted;

  // Slack renders this body to the invoking user only (the one synchronous
  // response any ingress route returns).
  return Response.json(
    { response_type: "ephemeral", text: "On it — I'll reply here shortly." },
    { status: 200 },
  );
}

/** POST /ingress/slack/interactivity — block actions (form field `payload`). */
export async function handleSlackInteractivityIngest(
  request: Request,
  env: Env,
  requestId: string,
  deps?: SlackIngressDeps,
): Promise<Response> {
  const read = await readVerified(request, env, requestId, deps);
  if (!read.ok) return read.response;

  const fields = parseForm(read.rawText);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(fields.payload ?? "") as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Missing interactivity payload", 400, requestId);
  }
  const triggerId = typeof payload.trigger_id === "string" ? payload.trigger_id : "";
  if (!DELIVERY_KEY_RE.test(triggerId)) {
    return errorResponse("bad_request", "Missing trigger id", 400, requestId);
  }

  return insertDelivery(
    env,
    requestId,
    { deliveryKey: `act.${triggerId}`, eventType: "interactivity", action: null, payload },
    { received: true },
    deps,
  );
}
