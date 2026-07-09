import type {
  CreateWebhookEndpointRequest,
  CreateWebhookSubscriptionRequest,
  PublicWebhookDeliveryAttempt,
  PublicWebhookEndpoint,
  PublicWebhookSubscription,
} from "@saas/contracts/webhooks";
import { z } from "zod";

import {
  deriveIdempotencyKey,
  idempotencyKeyArg,
  resolveIdempotencyKey,
} from "../idempotency.js";
import { compact, cursorArg, encodeStateCursor, limitArg, projectArg, scopedShape } from "../scope.js";
import { defineTool } from "../tool.js";

import type { ListDeliveryAttemptsQuery } from "@saas/sdk";

export const webhookDeliveriesListTool = defineTool({
  name: "webhook_deliveries_list",
  title: "List webhook deliveries",
  description:
    "Debug webhook delivery failures: pass `endpoint` (`whep_…`) to page through that endpoint's delivery attempts, newest first; omit it to list the workspace's endpoints so you can pick one. Read-only — to re-send a failed delivery use `webhook_delivery_replay`.",
  inputSchema: z.object({
    ...scopedShape,
    endpoint: z
      .string()
      .min(1)
      .describe("Webhook endpoint id. Omit to list endpoints instead of deliveries.")
      .optional(),
    cursor: cursorArg.optional(),
    limit: limitArg.optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    if (input.endpoint === undefined) {
      const res = await ctx.sdk.webhooks.listEndpoints(input.workspace);
      const data = {
        endpoints: res.endpoints,
        meta: { cursor: encodeStateCursor(res.nextCursor) },
      } satisfies {
        endpoints: PublicWebhookEndpoint[];
        meta: { cursor: string | null };
      };
      return {
        summary: `${res.endpoints.length} endpoint(s); pass one id as \`endpoint\` for its deliveries`,
        data,
      };
    }
    const page = await ctx.sdk.webhooks.listDeliveryAttemptsPage(
      input.workspace,
      input.endpoint,
      compact<ListDeliveryAttemptsQuery>({ cursor: input.cursor, limit: input.limit }),
    );
    const data = {
      deliveryAttempts: page.deliveryAttempts,
      meta: { cursor: page.nextCursor },
    } satisfies {
      deliveryAttempts: ReadonlyArray<PublicWebhookDeliveryAttempt>;
      meta: { cursor: string | null };
    };
    return {
      summary: `${page.deliveryAttempts.length} delivery attempt(s)`,
      data,
    };
  },
});

// ---------------------------------------------------------------------------
// Write tools (MCP5, design §4/§7) — the same public webhook mutations as the
// console/CLI, policy-gated + audited, replay-safe via Idempotency-Key.
// ---------------------------------------------------------------------------

export const webhookCreateTool = defineTool({
  name: "webhook_create",
  title: "Create webhook endpoint",
  description:
    "Create a webhook endpoint (delivery URL) in a workspace — optionally project-scoped via `project` — and subscribe it to the given `events` types in the same call. This is a WRITE: policy-gated (builder-or-higher role) and audited like any console/CLI mutation; retries are replay-safe (an Idempotency-Key is generated per call unless you supply `idempotencyKey`). Signing-secret material is never returned. To inspect deliveries use `webhook_deliveries_list`.",
  inputSchema: z.object({
    ...scopedShape,
    url: z.string().url().describe("Delivery URL the platform will POST signed events to."),
    name: z.string().min(1).describe("Human-readable endpoint name.").optional(),
    description: z.string().min(1).describe("What this endpoint is for.").optional(),
    project: projectArg
      .describe("Optional project scope (`prj_…`). Omit for a workspace-level endpoint.")
      .optional(),
    events: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Event types to subscribe the endpoint to (e.g. `run.completed`); each becomes a webhook subscription. Omit to create the endpoint with no subscriptions (it will receive nothing until subscribed).",
      )
      .optional(),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const idempotencyKey = resolveIdempotencyKey(input.idempotencyKey);
    const body = compact<CreateWebhookEndpointRequest>({
      url: input.url,
      name: input.name,
      description: input.description,
    });
    const created =
      input.project !== undefined
        ? await ctx.sdk.webhooks.createProjectEndpoint(input.workspace, input.project, body, {
            idempotencyKey,
          })
        : await ctx.sdk.webhooks.createEndpoint(input.workspace, body, { idempotencyKey });
    // Subscriptions ride derived keys (deterministic per base key), so a
    // retried call replays the endpoint create AND each subscription create.
    const subscriptions: PublicWebhookSubscription[] = [];
    for (const [i, eventType] of (input.events ?? []).entries()) {
      const subBody = compact<CreateWebhookSubscriptionRequest>({
        endpointId: created.endpoint.id,
        eventType,
        projectId: input.project,
      });
      const sub = await ctx.sdk.webhooks.createSubscription(input.workspace, subBody, {
        idempotencyKey: deriveIdempotencyKey(idempotencyKey, `:sub${i}`),
      });
      subscriptions.push(sub.subscription);
    }
    const data = { endpoint: created.endpoint, subscriptions } satisfies {
      endpoint: PublicWebhookEndpoint;
      subscriptions: PublicWebhookSubscription[];
    };
    return {
      summary: `created endpoint ${created.endpoint.id} (${created.endpoint.url}) with ${subscriptions.length} subscription(s)`,
      data,
    };
  },
});

export const webhookDeliveryReplayTool = defineTool({
  name: "webhook_delivery_replay",
  title: "Replay webhook delivery",
  description:
    "Re-send a past webhook delivery attempt to its endpoint through the normal signing/delivery path; returns the NEW attempt with its post-delivery status (the original is unchanged). Find attempt ids (`wha_…`) with `webhook_deliveries_list`. This is a WRITE: policy-gated and audited; retries are replay-safe (an Idempotency-Key is generated per call unless you supply `idempotencyKey`).",
  inputSchema: z.object({
    ...scopedShape,
    delivery: z
      .string()
      .min(1)
      .describe("Delivery attempt id (`wha_…`) from `webhook_deliveries_list`."),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const res = await ctx.sdk.webhooks.replayDelivery(input.workspace, input.delivery, {
      idempotencyKey: resolveIdempotencyKey(input.idempotencyKey),
    });
    const data = { deliveryAttempt: res.deliveryAttempt } satisfies {
      deliveryAttempt: PublicWebhookDeliveryAttempt;
    };
    return {
      summary: `replayed delivery ${input.delivery} → new attempt ${res.deliveryAttempt.id} (${res.deliveryAttempt.status})`,
      data,
    };
  },
});
