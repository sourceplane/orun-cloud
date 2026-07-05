import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";

// Authenticated state-worker routes proxied through the edge (OP4 — workspace
// links + tenancy resolution; OP2+ run/object planes land behind the same
// facade). The owning worker (state-worker) re-runs deny-by-default policy on
// every route; the edge only authenticates the bearer and forwards the actor.

// Org-scoped workspace-link create (state-api-contract §5).
const ORG_CLI_LINKS_RE = /^\/v1\/organizations\/[^/]+\/cli\/links$/;
// Org-independent resolve picker (state-api-contract §5).
const CLI_LINKS_RESOLVE_PATH = "/v1/cli/links/resolve";
// Console-management list + unlink (project Settings → CLI page).
const ORG_PROJECT_CLI_LINKS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/cli\/links(\/[^/]+)?$/;
// OP2 — run coordination plane: everything under the path-scoped /state base
// (runs, jobs, claim/heartbeat/update, runnable, cancel, logs). One prefix
// covers all of §2; the owning worker re-checks policy + the contract version.
const STATE_PLANE_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/state\//;
// OV6 — org-global catalog browser: org-scoped (no project), the merged catalog
// graph the console renders. Distinct from the project-scoped /state/catalog/*.
const ORG_CATALOG_ENTITIES_RE = /^\/v1\/organizations\/[^/]+\/catalog\/entities$/;
// WO5 — repo self-description read model: org-scoped list + per-project get.
const ORG_REPO_FACETS_RE = /^\/v1\/organizations\/[^/]+\/repo-facets(\/[^/]+)?$/;
// WO5 — console-facing overview doc read: org-scoped, deframed markdown by digest
// (?digest=). Distinct from the project-scoped /state/objects/{digest} object GET.
const ORG_CATALOG_DOC_RE = /^\/v1\/organizations\/[^/]+\/catalog\/doc$/;
// CD3 — the org-wide catalog doc index (Docs hub browse); plural, disjoint from
// the singular body read above.
const ORG_CATALOG_DOCS_RE = /^\/v1\/organizations\/[^/]+\/catalog\/docs$/;
// OV9 — org state-plane storage footprint: org-scoped (no project) STOCK gauge.
const ORG_STATE_USAGE_RE = /^\/v1\/organizations\/[^/]+\/state\/usage$/;
// Org-global runs feed: org-scoped (no project) — the console "Activities"
// surface. Distinct from the project-scoped /projects/{id}/state/runs.
const ORG_RUNS_RE = /^\/v1\/organizations\/[^/]+\/state\/runs$/;
// orun-work v2 (WP1) — the work lens: fold query API + coordination mutators,
// served by state-worker. Workspace-scoped; lifecycle derives on every read.
const ORG_WORK_RE = /^\/v1\/organizations\/[^/]+\/work(\/.*)?$/;
// Coordination hot path (coordination-api.md §2/§3): the per-job colon-verbs
// (:claim/:heartbeat/:complete), run :cancel, and the event-log/frontier reads.
// A whole DAG of concurrent jobs drives these under one CI token, so they ride a
// dedicated, higher rate-limit family (see rate-limit.ts). Run CREATE stays on
// the tighter `state` family — it's the real abuse vector, not the trusted,
// lease-gated verbs.
const COORDINATION_ROUTE_RE =
  /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/state\/runs\/[^/]+(?::cancel|\/jobs\/[^/]+:(?:claim|heartbeat|complete)|\/log|\/frontier)$/;

// `orun-contract-version` is forwarded so state-worker enforces the major and
// rejects unsupported skew with 409 contract_version_unsupported. `orun-object-
// kind` + `content-length` are forwarded for the OP3 object plane's digest-
// verified PUT (state-api-contract §3).
const FORWARDED_HEADERS = [
  "content-type",
  "content-length",
  "x-request-id",
  "traceparent",
  "idempotency-key",
  "orun-contract-version",
  "orun-object-kind",
];

export function isStateRoute(pathname: string): boolean {
  return (
    pathname === CLI_LINKS_RESOLVE_PATH ||
    ORG_CLI_LINKS_RE.test(pathname) ||
    ORG_PROJECT_CLI_LINKS_RE.test(pathname) ||
    ORG_CATALOG_ENTITIES_RE.test(pathname) ||
    ORG_REPO_FACETS_RE.test(pathname) ||
    ORG_CATALOG_DOC_RE.test(pathname) ||
    ORG_CATALOG_DOCS_RE.test(pathname) ||
    ORG_STATE_USAGE_RE.test(pathname) ||
    ORG_RUNS_RE.test(pathname) ||
    ORG_WORK_RE.test(pathname) ||
    STATE_PLANE_RE.test(pathname)
  );
}

export async function handleStateRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  // OP3 adds PUT for the object plane (digest-verified blob PUT, multipart part
  // upload) and catalog head advance.
  const allowedMethods = ["GET", "POST", "PUT", "DELETE"];
  if (!allowedMethods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  const routeFamily = COORDINATION_ROUTE_RE.test(pathname) ? "coordination" : "state";

  return replayOrExecute(request, requestId, env, routeFamily, async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    if (!env.STATE_WORKER) {
      return errorResponse("internal_error", "State service unavailable", 503, requestId);
    }

    const sessionResult = await resolveActor(request, env, requestId);
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    // Workflow actors (OV3) carry their bound (org, project) — the OIDC token is
    // the authorization, so state-worker grants within this scope without a role
    // lookup. Forwarded only when present (CLI/user actors have neither).
    if (sessionResult.orgId) headers.set("x-actor-org-id", sessionResult.orgId);
    if (sessionResult.projectId) headers.set("x-actor-project-id", sessionResult.projectId);
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://state.internal");

    try {
      const fetchInit: RequestInit = { method: request.method, headers };
      if (request.method === "POST" || request.method === "PUT") {
        fetchInit.body = request.body;
        // Streaming a request body through fetch requires duplex: 'half'.
        (fetchInit as RequestInit & { duplex?: string }).duplex = "half";
      }
      const downstream = await env.STATE_WORKER.fetch(target.toString(), fetchInit);
      return new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
    } catch {
      return errorResponse("internal_error", "State service unavailable", 503, requestId);
    }
  });
}
