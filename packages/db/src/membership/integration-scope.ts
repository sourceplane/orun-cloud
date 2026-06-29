import type { Organization } from "./types.js";

/**
 * The organization that owns the GitHub integration connection covering `org`:
 * its parent when it is a child organization, otherwise itself.
 *
 * This is the single resolution rule for the integration-tenancy model (epic
 * `saas-integration-tenancy`, IT1) — the twin of `effectiveBillingOrgId`. One
 * GitHub App installs exactly once per GitHub account, so when a customer runs
 * several orgs (workspaces) under one parent, the connection is owned at the
 * **account (parent) org** and every workspace resolves *up* to it for repo
 * links, scoped tokens, and events. The keystone never moves: there is still
 * exactly one connection per installation, owned by the account.
 *
 * Resolution applies only to **account-shared** connections (`scope = account`).
 * A workspace-private connection (`scope = workspace`, IT7) is owned at the
 * workspace and must NOT be resolved up — callers gate on the connection's scope
 * before applying this helper.
 *
 * For every existing (standalone) organization `parentOrgId` is NULL, so this
 * collapses to `org.id` and all current integration behavior is preserved
 * bit-for-bit. The seam stays dormant until a customer owns a parent account
 * with workspaces, and is unread by any live multi-org path until IT2+.
 */
export function effectiveIntegrationOrg(
  org: Pick<Organization, "id" | "parentOrgId">,
): string {
  return org.parentOrgId ?? org.id;
}
