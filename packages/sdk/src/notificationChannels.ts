import type {
  CreateNotificationChannelRequest,
  CreateNotificationChannelResponse,
  DeleteNotificationChannelResponse,
  ListNotificationChannelsResponse,
  TestNotificationChannelResponse,
  UpdateNotificationChannelRequest,
  UpdateNotificationChannelResponse,
} from "@saas/contracts/notifications";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Notification Channels resource client (saas-event-streaming ES3).
 *
 * Org-scoped CRUD + test-send for configured delivery channels (the first
 * kind is `slack_incoming_webhook`), served by `apps/notifications-worker` via
 * the api-edge `notification-channels-facade`.
 *
 * IMPORTANT: the channel config (the Slack webhook URL / `config_ciphertext`)
 * is WRITE-ONLY. It travels only on `create`/`update` bodies and is NEVER
 * echoed back — every response shape here omits the secret.
 *
 * NOTE: the facade exposes no single-channel GET (the collection GET lists all
 * channels; the item route serves only PATCH/DELETE/…/test), so there is
 * deliberately no `get(channelId)` method — use {@link list} to read a channel
 * projection.
 */
export class NotificationChannelsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/notification-channels */
  list(
    orgId: string,
    opts: RequestOptions = {},
  ): Promise<ListNotificationChannelsResponse["data"]> {
    return this.transport.request<ListNotificationChannelsResponse["data"]>(
      { method: "GET", path: channelsPath(orgId) },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/notification-channels
   *
   * The `webhookUrl` in `body` is write-only (encrypted at rest, never
   * returned). Pass `idempotencyKey` in `opts` for safe-retry semantics.
   */
  create(
    orgId: string,
    body: CreateNotificationChannelRequest,
    opts: RequestOptions = {},
  ): Promise<CreateNotificationChannelResponse["data"]> {
    return this.transport.request<CreateNotificationChannelResponse["data"]>(
      { method: "POST", path: channelsPath(orgId), body },
      opts,
    );
  }

  /**
   * PATCH /v1/organizations/:orgId/notification-channels/:channelId
   *
   * A `webhookUrl` in `body` rotates the (write-only) secret; it is never
   * returned on the response.
   */
  update(
    orgId: string,
    channelId: string,
    body: UpdateNotificationChannelRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateNotificationChannelResponse["data"]> {
    return this.transport.request<UpdateNotificationChannelResponse["data"]>(
      { method: "PATCH", path: channelPath(orgId, channelId), body },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/notification-channels/:channelId */
  delete(
    orgId: string,
    channelId: string,
    opts: RequestOptions = {},
  ): Promise<DeleteNotificationChannelResponse["data"]> {
    return this.transport.request<DeleteNotificationChannelResponse["data"]>(
      { method: "DELETE", path: channelPath(orgId, channelId) },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/notification-channels/:channelId/test
   *
   * Send a probe message through the channel and stamp `lastVerifiedAt` on
   * success. Returns `{ verified: true }`.
   */
  testSend(
    orgId: string,
    channelId: string,
    opts: RequestOptions = {},
  ): Promise<TestNotificationChannelResponse["data"]> {
    return this.transport.request<TestNotificationChannelResponse["data"]>(
      { method: "POST", path: `${channelPath(orgId, channelId)}/test` },
      opts,
    );
  }
}

function channelsPath(orgId: string): string {
  return `/v1/organizations/${encodeURIComponent(orgId)}/notification-channels`;
}

function channelPath(orgId: string, channelId: string): string {
  return `${channelsPath(orgId)}/${encodeURIComponent(channelId)}`;
}
