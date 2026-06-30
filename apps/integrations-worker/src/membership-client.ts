import type { AuthorizationContextResponse, MembershipFact } from "@saas/contracts/policy";

export type MembershipContextResult =
  | { ok: true; memberships: MembershipFact[] }
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

/** The Account that owns a child workspace's shared connection (IT10). */
export interface IntegrationParentAccount {
  /** Account org public id (`org_…`). */
  orgId: string;
  /** Account Workspace ID (`ws_…`, WID2) — led-with for attribution. */
  workspaceRef: string;
  /** Account display name. */
  name: string;
}

export type IntegrationParentResult =
  | { ok: true; isChild: boolean; account: IntegrationParentAccount | null }
  | { ok: false };

/**
 * Resolve a child workspace org to the Account that owns its shared GitHub
 * connection (saas-integration-tenancy IT10). Fails closed: any error returns
 * `{ ok: false }` so the caller renders the child's own connections only.
 */
export async function resolveIntegrationParent(
  membershipWorker: Fetcher,
  orgPublicId: string,
  requestId: string,
): Promise<IntegrationParentResult> {
  let response: Response;
  try {
    response = await membershipWorker.fetch(
      "http://membership-worker/v1/internal/membership/organizations/integration-parent",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ orgId: orgPublicId }),
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
  const data = (parsed as { data: unknown }).data as
    | { isChild?: unknown; account?: unknown }
    | null;
  if (!data || typeof data !== "object") return { ok: false };
  const isChild = data.isChild === true;
  const acc = data.account as IntegrationParentAccount | null;
  const account =
    acc && typeof acc.orgId === "string" && typeof acc.workspaceRef === "string" && typeof acc.name === "string"
      ? { orgId: acc.orgId, workspaceRef: acc.workspaceRef, name: acc.name }
      : null;
  return { ok: true, isChild, account };
}
