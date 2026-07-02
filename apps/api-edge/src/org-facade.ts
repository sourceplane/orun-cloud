import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const ORG_ROUTES: Record<string, string> = {
  "/v1/organizations": "POST|GET",
};

// Signed-in recipient's invitation discovery + token-less acceptance (saas
// invitation login flow). Same membership-worker + actor headers as the org
// routes, so they ride this facade; the worker keys them on x-actor-email.
const ME_INVITATIONS_RE = /^\/v1\/me\/invitations$/;
const ME_INVITATION_ACCEPT_RE = /^\/v1\/me\/invitations\/[^/]+\/accept$/;
const ORG_ID_RE = /^\/v1\/organizations\/[^/]+$/;
const ORG_MEMBERS_RE = /^\/v1\/organizations\/[^/]+\/members$/;
const ORG_MEMBER_ID_RE = /^\/v1\/organizations\/[^/]+\/members\/[^/]+$/;
const ORG_WORKSPACES_RE = /^\/v1\/organizations\/[^/]+\/workspaces$/;
const ORG_INVITATIONS_ACCEPT_RE = /^\/v1\/organizations\/[^/]+\/invitations\/accept$/;
const ORG_INVITATIONS_RE = /^\/v1\/organizations\/[^/]+\/invitations$/;
const ORG_INVITATION_ID_RE = /^\/v1\/organizations\/[^/]+\/invitations\/[^/]+$/;
const ORG_API_KEYS_RE = /^\/v1\/organizations\/[^/]+\/api-keys$/;
const ORG_API_KEY_ID_RE = /^\/v1\/organizations\/[^/]+\/api-keys\/[^/]+$/;
// teams-hub TH1c — account surface (proxied to membership-worker): account
// roles (WID6 grant + TH1a list/revoke) and the derived member roster (TH1b).
const ORG_ACCOUNT_ROLES_RE = /^\/v1\/organizations\/[^/]+\/account-roles$/;
const ORG_ACCOUNT_MEMBERS_RE = /^\/v1\/organizations\/[^/]+\/account-members$/;
// saas-teams TM4c — team management surface (proxied to membership-worker).
const ORG_TEAM_ROLES_RE = /^\/v1\/organizations\/[^/]+\/team-roles$/;
const ORG_TEAMS_RE = /^\/v1\/organizations\/[^/]+\/teams$/;
const ORG_TEAM_ID_RE = /^\/v1\/organizations\/[^/]+\/teams\/[^/]+$/;
const ORG_TEAM_MEMBERS_RE = /^\/v1\/organizations\/[^/]+\/teams\/[^/]+\/members$/;
const ORG_TEAM_MEMBER_ID_RE = /^\/v1\/organizations\/[^/]+\/teams\/[^/]+\/members\/[^/]+$/;
const ORG_EFFECTIVE_ACCESS_RE = /^\/v1\/organizations\/[^/]+\/effective-access$/;

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
];

export function isOrgRoute(pathname: string): boolean {
  return pathname in ORG_ROUTES || ME_INVITATIONS_RE.test(pathname) || ME_INVITATION_ACCEPT_RE.test(pathname) || ORG_ID_RE.test(pathname) || ORG_MEMBERS_RE.test(pathname) || ORG_MEMBER_ID_RE.test(pathname) || ORG_WORKSPACES_RE.test(pathname) || ORG_INVITATIONS_ACCEPT_RE.test(pathname) || ORG_INVITATIONS_RE.test(pathname) || ORG_INVITATION_ID_RE.test(pathname) || ORG_API_KEYS_RE.test(pathname) || ORG_API_KEY_ID_RE.test(pathname) || ORG_ACCOUNT_ROLES_RE.test(pathname) || ORG_ACCOUNT_MEMBERS_RE.test(pathname) || ORG_TEAM_ROLES_RE.test(pathname) || ORG_TEAMS_RE.test(pathname) || ORG_TEAM_ID_RE.test(pathname) || ORG_TEAM_MEMBERS_RE.test(pathname) || ORG_TEAM_MEMBER_ID_RE.test(pathname) || ORG_EFFECTIVE_ACCESS_RE.test(pathname);
}

export async function handleOrgRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const allowedMethods = ORG_ROUTES[pathname];
  if (allowedMethods && !allowedMethods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ME_INVITATIONS_RE.test(pathname) && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ME_INVITATION_ACCEPT_RE.test(pathname) && request.method !== "POST") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_INVITATIONS_ACCEPT_RE.test(pathname) && request.method !== "POST") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_MEMBERS_RE.test(pathname) && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_WORKSPACES_RE.test(pathname) && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_MEMBER_ID_RE.test(pathname) && request.method !== "PATCH" && request.method !== "DELETE") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_INVITATIONS_RE.test(pathname) && request.method !== "POST" && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_INVITATION_ID_RE.test(pathname) && !ORG_INVITATIONS_ACCEPT_RE.test(pathname) && request.method !== "DELETE") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_API_KEYS_RE.test(pathname) && request.method !== "POST" && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_API_KEY_ID_RE.test(pathname) && request.method !== "DELETE") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_ACCOUNT_ROLES_RE.test(pathname) && request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_ACCOUNT_MEMBERS_RE.test(pathname) && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_TEAM_ROLES_RE.test(pathname) && request.method !== "POST" && request.method !== "DELETE") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_TEAMS_RE.test(pathname) && request.method !== "POST" && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_TEAM_MEMBERS_RE.test(pathname) && request.method !== "GET" && request.method !== "POST") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_TEAM_MEMBER_ID_RE.test(pathname) && request.method !== "DELETE") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (
    ORG_TEAM_ID_RE.test(pathname) &&
    request.method !== "GET" &&
    request.method !== "PATCH" &&
    request.method !== "DELETE"
  ) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_EFFECTIVE_ACCESS_RE.test(pathname) && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_ID_RE.test(pathname) && !ORG_API_KEYS_RE.test(pathname) && !ORG_API_KEY_ID_RE.test(pathname) && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "org", async () => {

    if (!env.IDENTITY_WORKER) {
      return errorResponse(
        "internal_error",
        "Authentication service unavailable",
        503,
        requestId,
      );
    }

    if (!env.MEMBERSHIP_WORKER) {
      return errorResponse(
        "internal_error",
        "Membership service unavailable",
        503,
        requestId,
      );
    }

    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const sessionResult = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    if (sessionResult.orgId) {
    }
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const isApiKeyRoute = ORG_API_KEYS_RE.test(pathname) || ORG_API_KEY_ID_RE.test(pathname);
    const targetWorker = isApiKeyRoute ? env.IDENTITY_WORKER! : env.MEMBERSHIP_WORKER!;
    const targetHost = isApiKeyRoute ? "https://identity.internal" : "https://membership.internal";
    const target = new URL(pathname + url.search, targetHost);

    const init: RequestInit = {
      method: request.method,
      headers,
    };

    if (
      request.method === "POST" ||
      request.method === "PATCH" ||
      // Revoking a team grant or an account role is a DELETE carrying the
      // grant tuple in its body.
      (request.method === "DELETE" &&
        (ORG_TEAM_ROLES_RE.test(pathname) || ORG_ACCOUNT_ROLES_RE.test(pathname)))
    ) {
      init.body = request.body;
    }

    try {
      const downstream = await timings.measure("edge_downstream", () => targetWorker.fetch(target.toString(), init));
      const res = new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.org", timings);
    } catch {
      return errorResponse(
        "internal_error",
        "Membership service unavailable",
        503,
        requestId,
      );
    }
  });
}
