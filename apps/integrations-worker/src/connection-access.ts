// Read-up connection resolution (saas-integration-tenancy IT10).
//
// A child workspace sees its Account's shared (`account`-scoped) connections in
// its own integration list (handleListIntegrations), so it references them by
// the SAME id the Account owns. Any handler that then acts on that connection
// (list repos, link a repo, mint a token) must resolve it allowing read-up —
// a plain org-scoped getConnection() 404s because the row is owned by the
// Account, not the requesting workspace.
//
// This is the resolution twin of the inherited-row logic in
// handleListIntegrations: own connection, else an `account`-scoped connection
// owned by this workspace's Account, gated by admission under `granted` mode.
// Fails closed — any ambiguity resolves to null (treated as not_found).

import type { Env } from "./env.js";
import type { IntegrationConnection, IntegrationsRepository } from "@saas/db/integrations";
import { asUuid, type Uuid } from "@saas/db/ids";
import { resolveIntegrationParent } from "./membership-client.js";
import { orgPublicId, parseOrgPublicId } from "./ids.js";

/**
 * Resolve a connection the requesting org may use — one it OWNS, or an
 * `account`-scoped connection SHARED down to it from its Account. Returns the
 * connection (of any status; callers apply their own status checks) or null
 * when the org is not entitled to reference it.
 */
export async function resolveUsableConnection(
  env: Env,
  repo: IntegrationsRepository,
  orgId: Uuid,
  connectionId: Uuid,
  requestId: string,
): Promise<IntegrationConnection | null> {
  // Own connection — the common case, and cheapest.
  const own = await repo.getConnection(orgId, connectionId);
  if (own.ok) return own.value;

  // Read-up: only `account`-scoped connections are shareable, and only to a
  // child of the owning Account. Requires the membership worker to confirm the
  // parent relationship.
  if (!env.MEMBERSHIP_WORKER) return null;
  const byId = await repo.getConnectionById(connectionId);
  if (!byId.ok) return null;
  const connection = byId.value;
  if (connection.scope !== "account") return null;

  const parent = await resolveIntegrationParent(
    env.MEMBERSHIP_WORKER,
    orgPublicId(orgId),
    requestId,
  );
  if (!parent.ok || !parent.isChild || !parent.account) return null;
  const accountUuid = parseOrgPublicId(parent.account.orgId);
  if (!accountUuid || accountUuid !== connection.orgId) return null;

  // Under `granted` share mode the workspace must hold an active grant (D7).
  if (connection.shareMode === "granted") {
    const admitted = await repo.isWorkspaceAdmitted(asUuid(connection.id), orgId);
    if (!admitted.ok || !admitted.value) return null;
  }
  return connection;
}
