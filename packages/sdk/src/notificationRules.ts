import type {
  CreateNotificationRuleRequest,
  CreateNotificationRuleResponse,
  DeleteNotificationRuleResponse,
  GetNotificationRuleResponse,
  ListNotificationRulesResponse,
  TestNotificationRuleRequest,
  TestNotificationRuleResponse,
  UpdateNotificationRuleRequest,
  UpdateNotificationRuleResponse,
} from "@saas/contracts/notifications";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Notification Rules resource client (saas-event-streaming ES2).
 *
 * Org-scoped CRUD + dry-run test-fire, served by `apps/events-worker` via the
 * api-edge `notification-rules-facade`. A rule matches events by type globs,
 * a severity floor, optional source/attribute filters, and fans out to email
 * or Slack-channel targets. `test` synthesizes an event and reports whether
 * the rule would match — it never sends anything.
 */
export class NotificationRulesClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/notification-rules */
  list(
    orgId: string,
    opts: RequestOptions = {},
  ): Promise<ListNotificationRulesResponse["data"]> {
    return this.transport.request<ListNotificationRulesResponse["data"]>(
      { method: "GET", path: rulesPath(orgId) },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/notification-rules
   *
   * Pass `idempotencyKey` in `opts` for safe-retry semantics (forwarded as the
   * `Idempotency-Key` header).
   */
  create(
    orgId: string,
    body: CreateNotificationRuleRequest,
    opts: RequestOptions = {},
  ): Promise<CreateNotificationRuleResponse["data"]> {
    return this.transport.request<CreateNotificationRuleResponse["data"]>(
      { method: "POST", path: rulesPath(orgId), body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/notification-rules/:ruleId */
  get(
    orgId: string,
    ruleId: string,
    opts: RequestOptions = {},
  ): Promise<GetNotificationRuleResponse["data"]> {
    return this.transport.request<GetNotificationRuleResponse["data"]>(
      { method: "GET", path: rulePath(orgId, ruleId) },
      opts,
    );
  }

  /** PATCH /v1/organizations/:orgId/notification-rules/:ruleId */
  update(
    orgId: string,
    ruleId: string,
    body: UpdateNotificationRuleRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateNotificationRuleResponse["data"]> {
    return this.transport.request<UpdateNotificationRuleResponse["data"]>(
      { method: "PATCH", path: rulePath(orgId, ruleId), body },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/notification-rules/:ruleId */
  delete(
    orgId: string,
    ruleId: string,
    opts: RequestOptions = {},
  ): Promise<DeleteNotificationRuleResponse["data"]> {
    return this.transport.request<DeleteNotificationRuleResponse["data"]>(
      { method: "DELETE", path: rulePath(orgId, ruleId) },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/notification-rules/:ruleId/test
   *
   * Dry-run: synthesize an event from `body` and report whether this rule
   * would match and which targets would receive it. Never sends anything.
   */
  test(
    orgId: string,
    ruleId: string,
    body: TestNotificationRuleRequest,
    opts: RequestOptions = {},
  ): Promise<TestNotificationRuleResponse["data"]> {
    return this.transport.request<TestNotificationRuleResponse["data"]>(
      { method: "POST", path: `${rulePath(orgId, ruleId)}/test`, body },
      opts,
    );
  }
}

function rulesPath(orgId: string): string {
  return `/v1/organizations/${encodeURIComponent(orgId)}/notification-rules`;
}

function rulePath(orgId: string, ruleId: string): string {
  return `${rulesPath(orgId)}/${encodeURIComponent(ruleId)}`;
}
