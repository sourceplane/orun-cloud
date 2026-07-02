// Internal calls to membership-worker (service-binding only).
//
// Two seams the workspace-link surface needs:
//   - authorization-context: the actor's role memberships for an org, fed to
//     policy-worker for the deny-by-default `org.cli.link` check.
//   - subject-orgs: the full org list (id + slug + name + role) the actor
//     belongs to, used to (a) resolve org slugs for the link projection and
//     (b) scope `resolve` to only the actor's orgs.
//
// Both fail closed: an unreachable membership-worker returns `{ ok: false }`
// and the caller treats it as "no access" rather than guessing.

import type { AuthorizationContextResponse, MembershipFact } from "@saas/contracts/policy";
import type { CliSessionOrg } from "@saas/contracts/auth";

export type MembershipContextResult =
  | { ok: true; memberships: MembershipFact[] }
  | { ok: false };

export type SubjectOrgsResult =
  | { ok: true; orgs: CliSessionOrg[] }
  | { ok: false };

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
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ subject: { type: subjectType, id: subjectId }, orgId }),
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
  if (!data || typeof data !== "object" || !("memberships" in data)) return { ok: false };
  const typed = data as AuthorizationContextResponse;
  if (!Array.isArray(typed.memberships)) return { ok: false };
  return { ok: true, memberships: typed.memberships };
}

export type ResolveOrgRefResult =
  | { ok: true; orgUuid: string; slug: string }
  | { ok: false };

/**
 * Resolve any org reference spelling (`org_<hex>`, `ws_<8>`, or slug) to the
 * canonical org via membership-worker's internal resolve-org-ref (WID3). Used
 * by the SM3 secrets resolve to check a `secret://<workspace>/…` ref's
 * workspace segment against the path-scoped org. Fails closed.
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
  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) return { ok: false };
  const data = (parsed as { data: unknown }).data as { orgId?: unknown; slug?: unknown } | null;
  if (!data || typeof data.orgId !== "string") return { ok: false };
  // data.orgId is the public `org_<hex>` form; decode to the raw uuid.
  if (!data.orgId.startsWith("org_")) return { ok: false };
  const hex = data.orgId.slice(4);
  if (!/^[0-9a-f]{32}$/.test(hex)) return { ok: false };
  const orgUuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { ok: true, orgUuid, slug: typeof data.slug === "string" ? data.slug : "" };
}

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
