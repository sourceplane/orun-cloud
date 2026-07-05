import { createHyperdriveAdapter } from "@saas/db/hyperdrive";
import type { HealthStatus } from "@saas/contracts/health";
import type { Env } from "./env";
import { resolveRequestId, notFound } from "./http";
import { handlePreflight, applyCorsHeaders } from "./cors";
import { isAuthRoute, handleAuthRoute } from "./auth-facade";
import { isOrgRoute, handleOrgRoute } from "./org-facade";
import { isProjectRoute, handleProjectRoute } from "./project-facade";
import { isAuditRoute, handleAuditRoute } from "./audit-facade";
import { isDeadLettersRoute, handleDeadLettersRoute } from "./dead-letters-facade";
import { isEventGroupsRoute, handleEventGroupsRoute } from "./event-groups-facade";
import { isEventsRoute, handleEventsRoute } from "./events-facade";
import { isNotificationRulesRoute, handleNotificationRulesRoute } from "./notification-rules-facade";
import { isNotificationChannelsRoute, handleNotificationChannelsRoute } from "./notification-channels-facade";
import { isConfigRoute, handleConfigRoute } from "./config-facade";
import { isWebhooksRoute, handleWebhooksRoute } from "./webhooks-facade";
import { isMeteringRoute, handleMeteringRoute } from "./metering-facade";
import { isBillingRoute, handleBillingRoute } from "./billing-facade";
import { isBillingWebhookRoute, handleBillingWebhookRoute } from "./billing-webhooks-facade";
import { isNotificationsRoute, handleNotificationsRoute } from "./notifications-facade";
import {
  isIntegrationsRoute,
  isIntegrationsIngressRoute,
  handleIntegrationsRoute,
  handleIntegrationsIngressRoute,
} from "./integrations-facade";
import { isStateRoute, handleStateRoute } from "./state-facade";
import { isAccountAggregateRoute, handleAccountAggregateRoute } from "./account-facade";
import {
  isWorkspaceAliasRoute,
  rewriteWorkspacePath,
  rewriteToOrgRequest,
  projectWorkspaceAlias,
} from "./workspace-facade";
import { resolveOrgRefInPath, ORG_REF_NOT_FOUND } from "./org-ref-facade";

// Durable Object class backing the PERF5 Stage B rate-limit counters. Must be
// exported from the Worker entry so the runtime can instantiate it for the
// `RATE_LIMITER_DO` binding.
export { RateLimiterDO } from "./rate-limit-do";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const preflight = handlePreflight(request, env);
    if (preflight) return preflight;

    const url = new URL(request.url);
    const requestId = resolveRequestId(request);

    // Public Workspace vocabulary alias (saas-workspaces WS2): rewrite
    // `/v1/workspaces/*` to the canonical `/v1/organizations/*` before routing so
    // every org-scoped facade serves it unchanged, then project `workspaceId`
    // into the JSON response. The legacy org surface is untouched.
    const workspaceAlias = isWorkspaceAliasRoute(url.pathname);
    const aliasedRequest = workspaceAlias
      ? rewriteToOrgRequest(request, rewriteWorkspacePath(url.pathname))
      : request;
    const aliasedPathname = workspaceAlias ? rewriteWorkspacePath(url.pathname) : url.pathname;

    // Org-ref resolution (saas-workspace-id WID3): on the resulting
    // `/v1/organizations/{seg}` path, resolve a `ws_`/slug segment to the
    // canonical `org_<hex>` and rewrite ONLY that segment, so downstream workers
    // keep receiving the opaque id they already decode. Runs AFTER the workspace
    // rewrite so `/v1/workspaces/ws_…` resolves end-to-end. An already-`org_`
    // segment (all existing traffic) is a zero-overhead pass-through; an
    // unresolvable ref yields a 404 instead of being forwarded.
    const resolved = await resolveOrgRefInPath(aliasedPathname, aliasedRequest, env, requestId);
    if (resolved === ORG_REF_NOT_FOUND) {
      return applyCorsHeaders(notFound(requestId, url.pathname), request, env);
    }
    const routedRequest = resolved.request;
    const pathname = resolved.pathname;

    let response: Response;

    if (pathname === "/health") {
      response = await handleHealth(env);
    } else if (isAuthRoute(pathname)) {
      response = await handleAuthRoute(routedRequest, env, requestId, pathname);
    } else if (isAuditRoute(pathname)) {
      response = await handleAuditRoute(routedRequest, env, requestId, pathname);
    } else if (isDeadLettersRoute(pathname)) {
      response = await handleDeadLettersRoute(routedRequest, env, requestId, pathname);
    } else if (isEventGroupsRoute(pathname)) {
      response = await handleEventGroupsRoute(routedRequest, env, requestId, pathname);
    } else if (isEventsRoute(pathname)) {
      response = await handleEventsRoute(routedRequest, env, requestId, pathname);
    } else if (isNotificationRulesRoute(pathname)) {
      response = await handleNotificationRulesRoute(routedRequest, env, requestId, pathname);
    } else if (isNotificationChannelsRoute(pathname)) {
      response = await handleNotificationChannelsRoute(routedRequest, env, requestId, pathname);
    } else if (isConfigRoute(pathname)) {
      response = await handleConfigRoute(routedRequest, env, requestId, pathname);
    } else if (isIntegrationsIngressRoute(pathname)) {
      // Public install-callback ingress (no session) — authenticated by the
      // signed single-use state verified in integrations-worker.
      response = await handleIntegrationsIngressRoute(routedRequest, env, requestId, pathname);
    } else if (isIntegrationsRoute(pathname)) {
      response = await handleIntegrationsRoute(routedRequest, env, requestId, pathname);
    } else if (isStateRoute(pathname)) {
      // Workspace links + tenancy resolution (OP4) and the OP2+ state planes.
      response = await handleStateRoute(routedRequest, env, requestId, pathname);
    } else if (isAccountAggregateRoute(pathname)) {
      // teams-hub TH2 — account-catalog / account-runs: bounded fan-out over
      // the account's workspace set across the per-org state indexes.
      response = await handleAccountAggregateRoute(routedRequest, env, requestId, pathname);
    } else if (isBillingWebhookRoute(pathname)) {
      // Public inbound provider webhook (no session) — matched before the
      // authenticated webhooks/billing facades.
      response = await handleBillingWebhookRoute(routedRequest, env, requestId, pathname);
    } else if (isWebhooksRoute(pathname)) {
      response = await handleWebhooksRoute(routedRequest, env, requestId, pathname);
    } else if (isNotificationsRoute(pathname)) {
      response = await handleNotificationsRoute(routedRequest, env, requestId, pathname);
    } else if (isMeteringRoute(pathname)) {
      response = await handleMeteringRoute(routedRequest, env, requestId, pathname);
    } else if (isBillingRoute(pathname)) {
      response = await handleBillingRoute(routedRequest, env, requestId, pathname);
    } else if (isProjectRoute(pathname)) {
      response = await handleProjectRoute(routedRequest, env, requestId, pathname);
    } else if (isOrgRoute(pathname)) {
      response = await handleOrgRoute(routedRequest, env, requestId, pathname);
    } else {
      response = notFound(requestId, pathname);
    }

    if (workspaceAlias) {
      response = await projectWorkspaceAlias(response);
    }

    return applyCorsHeaders(response, request, env);
  },
} satisfies ExportedHandler<Env>;

async function handleHealth(env: Env): Promise<Response> {
  const db = await checkDatabase(env);
  const identity = checkIdentityBinding(env);
  const membership = checkMembershipBinding(env);

  const status: HealthStatus = !db.configured
    ? "ok"
    : db.reachable
      ? "ok"
      : "degraded";

  const code = status === "ok" ? 200 : 503;

  return Response.json(
    {
      status,
      service: "api-edge",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      checks: { database: db, identity, membership },
    },
    { status: code },
  );
}

function checkIdentityBinding(env: Env): { configured: boolean } {
  return { configured: !!env.IDENTITY_WORKER };
}

function checkMembershipBinding(env: Env): { configured: boolean } {
  return { configured: !!env.MEMBERSHIP_WORKER };
}

async function checkDatabase(
  env: Env,
): Promise<{ configured: boolean; reachable: boolean }> {
  if (!env.PLATFORM_DB) {
    return { configured: false, reachable: false };
  }

  const adapter = createHyperdriveAdapter(env.PLATFORM_DB);
  try {
    return await adapter.ping();
  } finally {
    await adapter.dispose();
  }
}
