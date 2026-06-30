import type { AuthorizationContextResponse, MembershipFact } from "@saas/contracts/policy";
import type { CliSessionOrg } from "@saas/contracts/auth";

export type MembershipContextResult =
  | { ok: true; memberships: MembershipFact[] }
  | { ok: false };

export type SubjectOrgsResult =
  | { ok: true; orgs: CliSessionOrg[] }
  | { ok: false };

/**
 * Fetch a subject's orgs (with org-level role) for the CLI session payload (OP1).
 * Failure-soft: an unreachable membership-worker returns `{ ok: false }` and the
 * caller treats the session as having no org scope rather than failing login.
 */
export async function fetchSubjectOrgs(
  membershipWorker: Fetcher,
  subjectId: string,
  subjectType: string,
  requestId: string,
): Promise<SubjectOrgsResult> {
  let response: Response;
  try {
    response = await membershipWorker.fetch(
      "http://membership-worker/v1/internal/membership/subject-orgs",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ subject: { type: subjectType, id: subjectId } }),
      },
    );
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) return { ok: false };
  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object" || !("orgs" in data)) return { ok: false };
  const orgs = (data as { orgs: unknown }).orgs;
  if (!Array.isArray(orgs)) return { ok: false };
  return { ok: true, orgs: orgs as CliSessionOrg[] };
}

export type ResolveOrgRefResult =
  | { ok: true; orgId: string }
  | { ok: false };

/**
 * Resolve any org reference spelling (`ws_`/slug/`org_`) to the canonical
 * `org_<hex>` via membership-worker (saas-workspace-id WID3). Used by the CLI
 * tenancy-claim path (oidc-exchange) so an `execution.state.org` hint may be a
 * `ws_` or slug, not only an `org_<hex>`. Failure-soft: an unreachable
 * membership-worker or an unknown ref returns `{ ok: false }`.
 */
export async function resolveOrgRef(
  membershipWorker: Fetcher,
  ref: string,
  requestId: string,
): Promise<ResolveOrgRefResult> {
  let response: Response;
  try {
    response = await membershipWorker.fetch(
      "http://membership-worker/v1/internal/membership/resolve-org-ref",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ ref }),
      },
    );
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false };
  }
  const data = (parsed as { data?: { orgId?: unknown } } | null)?.data;
  const orgId = data?.orgId;
  if (typeof orgId !== "string" || !orgId.startsWith("org_")) return { ok: false };
  return { ok: true, orgId };
}

export async function fetchAuthorizationContext(
  membershipWorker: Fetcher,
  subjectId: string,
  subjectType: string,
  orgId: string,
  requestId: string,
): Promise<MembershipContextResult> {
  let response: Response;
  try {
    response = await membershipWorker.fetch(
      "http://membership-worker/v1/internal/membership/authorization-context",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify({
          subject: { type: subjectType, id: subjectId },
          orgId,
        }),
      },
    );
  } catch {
    return { ok: false };
  }

  if (!response.ok) {
    return { ok: false };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { ok: false };
  }

  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object" || !("memberships" in data)) {
    return { ok: false };
  }

  const typed = data as AuthorizationContextResponse;
  if (!Array.isArray(typed.memberships)) {
    return { ok: false };
  }

  return { ok: true, memberships: typed.memberships };
}
