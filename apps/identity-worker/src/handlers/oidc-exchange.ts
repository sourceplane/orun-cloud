// GitHub Actions OIDC exchange (OV3 — design-v2 §4, credential-agnostic CI auth).
//
// A CI job with no stored secret presents its GitHub Actions OIDC token; this
// endpoint verifies it (RS256/JWKS), resolves the repo to a linked
// (org, project) on the rename-stable repository_id, gates on the link's CI
// settings (OV3.1), and mints a short-lived actorKind:"workflow" access token —
// the same HS256 envelope the api-edge bearer path already resolves. The
// workspace link IS the trust binding (DV4): no separate oidc_trust_bindings.

import type { Env } from "../env.js";
import type { OidcExchangeResponse } from "@saas/contracts/auth";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { createStateRepository, type WorkspaceLink } from "@saas/db/state";
import { successResponse, errorResponse } from "../http.js";
import { orgPublicId, projectPublicId } from "../ids.js";
import { verifyGitHubOidcToken, type JwksFetcher, type GitHubOidcClaims } from "../oidc/github.js";
import { mintWorkflowAccessToken } from "../cli/jwt.js";

/** Frozen OIDC audience the CLI requests and this endpoint requires (design §8). */
const OIDC_AUDIENCE = "orun-cloud";
const PROVIDER = "github";

export interface OidcExchangeDeps {
  executor?: SqlExecutor;
  fetchJwks?: JwksFetcher;
  now?: () => Date;
}

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

/** Glob match over the Actions `ref` claim: `*` is any run, others are literal. */
function refMatches(pattern: string, ref: string | undefined): boolean {
  if (!ref) return false; // a pattern is set but the token carries no ref → deny
  const rx = "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  try {
    return new RegExp(rx).test(ref);
  } catch {
    return false;
  }
}

/** Apply the per-link CI gate to an OIDC token's claims. Returns null when ok,
 *  else a short deny reason for the audit/error. */
function gate(link: WorkspaceLink, claims: GitHubOidcClaims): string | null {
  const ci = link.ciSettings;
  if (!ci.oidcEnabled) return "oidc_disabled";
  if (ci.allowedRefPattern && !refMatches(ci.allowedRefPattern, claims.ref)) return "ref_not_allowed";
  if (ci.allowedEnvironments) {
    // A run targeting an environment must be in the allowlist; a run with no
    // environment is allowed only if the allowlist is empty-permissive — here an
    // explicit non-null list always requires a matching environment claim.
    if (!claims.environment || !ci.allowedEnvironments.includes(claims.environment)) {
      return "environment_not_allowed";
    }
  }
  return null;
}

// Denial-shape contract the CLI relies on (specs/oidc-ci-tenancy §2.2/§5,
// decisions D1/D4). Kept stable on purpose:
//   401 not_found? no — 401 unauthenticated  → bad/expired/wrong-aud OIDC token.
//   404 not_found                            → repo not linked, or declared org
//        matches no authorized link. Resource-hiding: existence/membership
//        collapse to one Not-Found (same shape as the state-worker push gate and
//        the link APIs). The exchange NEVER auto-creates here (D1).
//   409 conflict                             → repo linked to MULTIPLE orgs and
//        no org hint. Not a denial: a disambiguation prompt for a repo the
//        caller provably controls (declare execution.state.org). Safe to reveal.
//   403 forbidden + details.reason           → per-link CI gate (oidc_disabled /
//        ref_not_allowed / environment_not_allowed) on a KNOWN, allow-listed
//        link. The owner can fix the toggle, so the actionable reason is kept
//        rather than hidden — the caller already proved control of the repo.
export async function handleOidcExchange(
  request: Request,
  env: Env,
  requestId: string,
  deps?: OidcExchangeDeps,
): Promise<Response> {
  const now = deps?.now ? deps.now() : new Date();

  let body: { token?: unknown; org?: unknown };
  try {
    body = (await request.json()) as { token?: unknown; org?: unknown };
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) {
    return errorResponse("validation_failed", "token is required", 422, requestId);
  }
  const orgHint = typeof body.org === "string" && body.org.length > 0 ? body.org : null;

  // 1) Verify the GitHub OIDC token (signature + iss/aud/exp).
  const claims = await verifyGitHubOidcToken(token, {
    audience: OIDC_AUDIENCE,
    now,
    fetchJwks: deps?.fetchJwks,
  });
  if (!claims) {
    return errorResponse("unauthenticated", "Invalid or expired OIDC token", 401, requestId);
  }

  if (!env.PLATFORM_DB && !deps?.executor) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }
  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);

    // 2) Resolve the rename-stable repo id to active workspace links.
    const linksResult = await repo.listActiveWorkspaceLinksForProviderRepo(PROVIDER, claims.repository_id);
    if (!linksResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const links = linksResult.value;
    if (links.length === 0) {
      // Repo not bound to any org — fail closed, no auto-claim of unsolicited
      // repos (decision D1: the exchange NEVER auto-creates a link/project on the
      // workflow path). The denial is a 404 resource-hiding "not found" — the
      // same shape the state-worker push gate (requireWorkflowRepoAllowed) and
      // the link APIs use — so "not linked" and "not a member" collapse to one
      // Not-Found and the CLI keys on a single, stable denial code
      // (specs/oidc-ci-tenancy §2.2/§5; the CLI must not infer "forbidden").
      return errorResponse(
        "not_found",
        "Not found",
        404,
        requestId,
      );
    }

    // 3) Disambiguate across orgs via the checked org hint (intent.yaml).
    let link: WorkspaceLink;
    if (links.length === 1) {
      link = links[0]!;
    } else {
      if (!orgHint) {
        return errorResponse(
          "conflict",
          "Repository is linked to multiple orgs; declare execution.state.org in intent.yaml",
          409,
          requestId,
        );
      }
      const matches = links.filter((l) => orgPublicId(l.orgId) === orgHint);
      if (matches.length !== 1) {
        // The declared org names no authorized link for this repo. Hide whether
        // the org exists / the repo is linked elsewhere behind the same 404
        // resource-hiding shape as the "no link" case above
        // (specs/oidc-ci-tenancy §2.2/§5, decision D4).
        return errorResponse(
          "not_found",
          "Not found",
          404,
          requestId,
        );
      }
      link = matches[0]!;
    }

    // 4) Gate on the link's per-link CI settings (OV3.1).
    const denyReason = gate(link, claims);
    if (denyReason) {
      return errorResponse("forbidden", `OIDC denied: ${denyReason}`, 403, requestId, {
        reason: denyReason,
      });
    }

    // 5) Mint the short-lived workflow access token bound to (org, project).
    const orgPub = orgPublicId(link.orgId);
    const projectPub = projectPublicId(link.projectId);
    let minted: { token: string; expiresAt: Date };
    try {
      minted = await mintWorkflowAccessToken(env, {
        sub: claims.sub,
        orgId: orgPub,
        projectId: projectPub,
        now,
      });
    } catch {
      // Signing key unconfigured — never a silent grant.
      return errorResponse("internal_error", "Token signing unavailable", 503, requestId);
    }

    const payload: OidcExchangeResponse = {
      accessToken: minted.token,
      tokenType: "Bearer",
      expiresAt: minted.expiresAt.toISOString(),
      orgId: orgPub,
      projectId: projectPub,
    };
    return successResponse(payload, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}
