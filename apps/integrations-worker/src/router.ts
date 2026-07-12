import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleGithubSetupCallback } from "./handlers/setup.js";
import { handleGithubWebhookIngest } from "./handlers/ingest.js";
import { handleListDeliveries, handleReplayDelivery } from "./handlers/deliveries.js";
import { handleListRepositories } from "./handlers/repositories.js";
import { handleIssueGithubToken } from "./handlers/token-broker.js";
import { handleWritebackInternal } from "./handlers/writeback-internal.js";
import {
  handleCreateRepoLink,
  handleListRepoLinks,
  handleUnlinkRepoLink,
  handleUpdateRepoLink,
} from "./handlers/repo-links.js";
import {
  handleConnectIntegration,
  handleGetIntegration,
  handleListIntegrations,
  handleRevokeIntegration,
  isConnectableProvider,
} from "./handlers/connections.js";
import { handleSlackOauthCallback, SLACK_OAUTH_CALLBACK_PATH } from "./handlers/slack-oauth.js";
import { handleListSlackChannels } from "./handlers/slack-channels.js";
import { handleSlackCredentialsInternal } from "./handlers/slack-credentials-internal.js";
import {
  handleCreateConnectionGrant,
  handleListConnectionGrants,
  handleRevokeConnectionGrant,
  handleUpdateConnection,
} from "./handlers/grants.js";
import {
  generateRequestId,
  parseConnectionPublicId,
  parseInboundDeliveryPublicId,
  parseOrgPublicId,
  parseProjectPublicId,
  parseRepoLinkPublicId,
} from "./ids.js";
import { asUuid } from "@saas/db/ids";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

// Internal service-binding boundary (IG9.3). Inbound internal calls carry this
// header; only a worker behind a service binding can set it (the public edge
// strips client-supplied x-internal-* headers), so it cannot be forged from
// outside the trust boundary. Add a caller here when a new bounded context
// gains a service binding to this worker. Avoid wildcards.
const INTERNAL_CALLER_HEADER = "x-internal-caller";
const INTERNAL_CALLER_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ALLOWED_INTERNAL_CALLERS: ReadonlySet<string> = new Set([
  // state-worker drives the write-back proxy on a run-result event (OV5).
  "state-worker",
  // notifications-worker reads slack_app delivery credentials per send (IH2).
  "notifications-worker",
]);

function isAllowedInternalCaller(value: string | null): value is string {
  if (!value) return false;
  if (!INTERNAL_CALLER_RE.test(value)) return false;
  return ALLOWED_INTERNAL_CALLERS.has(value);
}

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

const ORG_INTEGRATIONS_RE = /^\/v1\/organizations\/([^/]+)\/integrations$/;
const ORG_INTEGRATIONS_CONNECT_RE = /^\/v1\/organizations\/([^/]+)\/integrations\/([a-z]+)\/connect$/;
const ORG_INTEGRATION_RE = /^\/v1\/organizations\/([^/]+)\/integrations\/([^/]+)$/;
const ORG_DELIVERIES_RE = /^\/v1\/organizations\/([^/]+)\/integrations\/([^/]+)\/deliveries$/;
const ORG_DELIVERY_REPLAY_RE =
  /^\/v1\/organizations\/([^/]+)\/integrations\/([^/]+)\/deliveries\/([^/]+)\/replay$/;
const ORG_GITHUB_TOKEN_RE = /^\/v1\/organizations\/([^/]+)\/integrations\/github\/token$/;
const ORG_CONNECTION_REPOSITORIES_RE =
  /^\/v1\/organizations\/([^/]+)\/integrations\/([^/]+)\/repositories$/;
const ORG_CONNECTION_GRANTS_RE =
  /^\/v1\/organizations\/([^/]+)\/integrations\/([^/]+)\/grants$/;
const ORG_CONNECTION_GRANT_RE =
  /^\/v1\/organizations\/([^/]+)\/integrations\/([^/]+)\/grants\/([^/]+)$/;
const PROJECT_REPO_LINKS_RE =
  /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/repo-links$/;
const PROJECT_REPO_LINK_RE =
  /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/repo-links\/([^/]+)$/;
const ORG_CONNECTION_SLACK_CHANNELS_RE =
  /^\/v1\/organizations\/([^/]+)\/integrations\/([^/]+)\/slack\/channels$/;
const GITHUB_SETUP_PATH = "/ingress/github/setup";
const GITHUB_WEBHOOK_PATH = "/ingress/github/webhook";
const GITHUB_WRITEBACK_PATH = "/internal/github/writeback";
const SLACK_CREDENTIALS_PATH = "/internal/slack/credentials";

export async function route(request: Request, env: Env): Promise<Response> {
  const requestId = resolveRequestId(request);
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Health check — no auth required
  if (pathname === "/health") {
    return handleHealth(env, requestId);
  }

  // Install-callback ingress (design §4/§5): authenticated by signed state,
  // not by a bearer token — reached only via api-edge's allowlisted forward.
  if (pathname === GITHUB_SETUP_PATH) {
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleGithubSetupCallback(request, env, requestId);
  }

  // Slack OAuth-callback ingress (IH1): the oauth-kind twin of the GitHub
  // setup callback — signed single-use state, same fail-closed orphan rule.
  if (pathname === SLACK_OAUTH_CALLBACK_PATH) {
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleSlackOauthCallback(request, env, requestId);
  }

  // Inbound webhook ingress: authenticated by HMAC over the raw body, never
  // by a bearer token (design §5). Verify-insert-ack; the cron drain does
  // the rest.
  if (pathname === GITHUB_WEBHOOK_PATH) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleGithubWebhookIngest(request, env, requestId);
  }

  // Internal write-back driver (IG9.3 outbound bridge): state-worker posts a
  // run result here and this worker — which alone holds the App key — mints a
  // scoped token and writes it back to GitHub. Authenticated by the
  // service-binding boundary (x-internal-caller), never a user bearer.
  if (pathname === GITHUB_WRITEBACK_PATH) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    if (!isAllowedInternalCaller(request.headers.get(INTERNAL_CALLER_HEADER))) {
      return errorResponse("unauthorized", "Internal service-binding required", 403, requestId);
    }
    if (!env.PLATFORM_DB) {
      return errorResponse("internal_error", "Database not configured", 503, requestId);
    }
    return handleWritebackInternal(request, env, requestId);
  }

  // Internal slack_app delivery-credential read (IH2, design §4.2): the bot
  // token crosses ONLY the service binding; the caller holds it in isolate
  // memory. Authenticated by the binding boundary, never a user bearer.
  if (pathname === SLACK_CREDENTIALS_PATH) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    if (!isAllowedInternalCaller(request.headers.get(INTERNAL_CALLER_HEADER))) {
      return errorResponse("unauthorized", "Internal service-binding required", 403, requestId);
    }
    if (!env.PLATFORM_DB) {
      return errorResponse("internal_error", "Database not configured", 503, requestId);
    }
    return handleSlackCredentialsInternal(request, env, requestId);
  }

  // Everything below is the authenticated org surface.
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }
  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Authorization services not configured", 503, requestId);
  }

  const actor = resolveActor(request);
  if (!actor) {
    return errorResponse("unauthenticated", "Authentication required", 401, requestId);
  }

  let m: RegExpMatchArray | null;

  m = pathname.match(ORG_INTEGRATIONS_CONNECT_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const provider = m[2]!;
    if (!orgId || !isConnectableProvider(provider)) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    if (!env.BILLING_WORKER) {
      return errorResponse("internal_error", "Entitlement service not configured", 503, requestId);
    }
    return handleConnectIntegration(request, env, requestId, actor, orgId, provider);
  }

  m = pathname.match(ORG_INTEGRATIONS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListIntegrations(request, env, requestId, actor, orgId);
  }

  m = pathname.match(ORG_GITHUB_TOKEN_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    if (!env.BILLING_WORKER) {
      return errorResponse("internal_error", "Entitlement service not configured", 503, requestId);
    }
    return handleIssueGithubToken(request, env, requestId, actor, orgId);
  }

  m = pathname.match(ORG_CONNECTION_SLACK_CHANNELS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const connectionUuid = parseConnectionPublicId(m[2]!);
    if (!orgId || !connectionUuid) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListSlackChannels(request, env, requestId, actor, orgId, asUuid(connectionUuid));
  }

  m = pathname.match(ORG_CONNECTION_REPOSITORIES_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const connectionUuid = parseConnectionPublicId(m[2]!);
    if (!orgId || !connectionUuid) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListRepositories(request, env, requestId, actor, orgId, asUuid(connectionUuid));
  }

  m = pathname.match(ORG_CONNECTION_GRANTS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const connectionUuid = parseConnectionPublicId(m[2]!);
    if (!orgId || !connectionUuid) return notFound(requestId, pathname);
    switch (request.method) {
      case "GET":
        return handleListConnectionGrants(env, requestId, actor, orgId, asUuid(connectionUuid));
      case "POST":
        return handleCreateConnectionGrant(request, env, requestId, actor, orgId, asUuid(connectionUuid));
      default:
        return methodNotAllowed(requestId);
    }
  }

  m = pathname.match(ORG_CONNECTION_GRANT_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const connectionUuid = parseConnectionPublicId(m[2]!);
    const workspaceOrgUuid = parseOrgPublicId(m[3]!);
    if (!orgId || !connectionUuid || !workspaceOrgUuid) return notFound(requestId, pathname);
    if (request.method !== "DELETE") return methodNotAllowed(requestId);
    return handleRevokeConnectionGrant(
      env,
      requestId,
      actor,
      orgId,
      asUuid(connectionUuid),
      asUuid(workspaceOrgUuid),
    );
  }

  m = pathname.match(PROJECT_REPO_LINKS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectUuid = parseProjectPublicId(m[2]!);
    if (!orgId || !projectUuid) return notFound(requestId, pathname);
    switch (request.method) {
      case "GET":
        return handleListRepoLinks(request, env, requestId, actor, orgId, projectUuid);
      case "POST":
        if (!env.BILLING_WORKER) {
          return errorResponse("internal_error", "Entitlement service not configured", 503, requestId);
        }
        return handleCreateRepoLink(request, env, requestId, actor, orgId, projectUuid);
      default:
        return methodNotAllowed(requestId);
    }
  }

  m = pathname.match(PROJECT_REPO_LINK_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectUuid = parseProjectPublicId(m[2]!);
    const repoLinkUuid = parseRepoLinkPublicId(m[3]!);
    if (!orgId || !projectUuid || !repoLinkUuid) return notFound(requestId, pathname);
    switch (request.method) {
      case "PATCH":
        return handleUpdateRepoLink(request, env, requestId, actor, orgId, projectUuid, asUuid(repoLinkUuid));
      case "DELETE":
        return handleUnlinkRepoLink(env, requestId, actor, orgId, projectUuid, asUuid(repoLinkUuid));
      default:
        return methodNotAllowed(requestId);
    }
  }

  m = pathname.match(ORG_DELIVERIES_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const connectionUuid = parseConnectionPublicId(m[2]!);
    if (!orgId || !connectionUuid) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListDeliveries(request, env, requestId, actor, orgId, asUuid(connectionUuid));
  }

  m = pathname.match(ORG_DELIVERY_REPLAY_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const connectionUuid = parseConnectionPublicId(m[2]!);
    const deliveryUuid = parseInboundDeliveryPublicId(m[3]!);
    if (!orgId || !connectionUuid || !deliveryUuid) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleReplayDelivery(
      env,
      requestId,
      actor,
      orgId,
      asUuid(connectionUuid),
      asUuid(deliveryUuid),
    );
  }

  m = pathname.match(ORG_INTEGRATION_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const connectionUuid = parseConnectionPublicId(m[2]!);
    if (!orgId || !connectionUuid) return notFound(requestId, pathname);
    switch (request.method) {
      case "GET":
        return handleGetIntegration(env, requestId, actor, orgId, asUuid(connectionUuid));
      case "PATCH":
        return handleUpdateConnection(request, env, requestId, actor, orgId, asUuid(connectionUuid));
      case "DELETE":
        return handleRevokeIntegration(env, requestId, actor, orgId, asUuid(connectionUuid));
      default:
        return methodNotAllowed(requestId);
    }
  }

  return notFound(requestId, pathname);
}
