import type {
  AuthorizationRequest,
  AuthorizationResponse,
  PolicySubject,
  MembershipFact,
  EffectivePermissionsRequest,
  EffectivePermissionsResponse,
  EffectivePermission,
} from "@saas/contracts/policy";
import type { RoleAssignment } from "@saas/db/membership";
import type { ActorContext } from "./router.js";
import { mapRoleAssignmentsToFacts } from "./membership-facts.js";

export interface AuthorizeParams {
  actor: ActorContext;
  action: string;
  resource: { kind: string; id?: string; orgId: string; projectId?: string };
  orgId: string;
  roleAssignments: RoleAssignment[];
  requestId: string;
}

export interface AuthorizeResult {
  allow: boolean;
}

function mapRoleAssignments(orgId: string, assignments: RoleAssignment[]): ReturnType<typeof mapRoleAssignmentsToFacts> {
  return mapRoleAssignmentsToFacts(orgId, assignments);
}

export async function authorizeViaPolicy(
  policyWorker: Fetcher,
  params: AuthorizeParams,
): Promise<AuthorizeResult> {
  const subject: PolicySubject = {
    type: params.actor.subjectType as PolicySubject["type"],
    id: params.actor.subjectId,
  };

  const body: AuthorizationRequest = {
    subject,
    action: params.action,
    resource: params.resource,
    context: {
      memberships: mapRoleAssignments(params.orgId, params.roleAssignments),
    },
  };

  let response: Response;
  try {
    response = await policyWorker.fetch("http://policy-worker/v1/internal/policy/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": params.requestId,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { allow: false };
  }

  if (!response.ok) {
    return { allow: false };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { allow: false };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { allow: false };
  }

  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object" || !("allow" in data) || typeof (data as AuthorizationResponse).allow !== "boolean") {
    return { allow: false };
  }

  return { allow: (data as AuthorizationResponse).allow };
}

/**
 * List the actor's effective permissions (with per-action provenance, TM6b) for
 * an already-assembled fact set on a target resource. Thin wrapper over the
 * policy worker's `/v1/internal/policy/effective-permissions`. Returns [] on any
 * transport/parse error (fail-closed: no permissions rather than a false grant).
 */
export async function effectivePermissionsViaPolicy(
  policyWorker: Fetcher,
  params: {
    subject: PolicySubject;
    resource: { kind: string; id?: string; orgId: string; projectId?: string };
    memberships: MembershipFact[];
    requestId: string;
  },
): Promise<EffectivePermission[]> {
  const body: EffectivePermissionsRequest = {
    subject: params.subject,
    resource: params.resource,
    context: { memberships: params.memberships },
  };
  let response: Response;
  try {
    response = await policyWorker.fetch("http://policy-worker/v1/internal/policy/effective-permissions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": params.requestId },
      body: JSON.stringify(body),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) return [];
  const data = (parsed as { data: unknown }).data as EffectivePermissionsResponse | undefined;
  return Array.isArray(data?.permissions) ? data!.permissions : [];
}

export { mapRoleAssignments };
