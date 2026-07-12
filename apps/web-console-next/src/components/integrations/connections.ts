/**
 * Pure view-model helpers for the Integrations settings surface.
 * Dependency-free (no React) so the status/labels logic is unit-testable.
 */
import type {
  IntegrationConnectionScope,
  IntegrationConnectionShareMode,
  IntegrationConnectionStatus,
  PublicConnection,
} from "@saas/contracts/integrations";

export interface ConnectionStatusMeta {
  label: string;
  /** Badge tone consumed by the renderer. */
  tone: "default" | "success" | "warning" | "destructive";
}

export const CONNECTION_STATUS_META: Record<IntegrationConnectionStatus, ConnectionStatusMeta> = {
  pending: { label: "Pending", tone: "warning" },
  active: { label: "Active", tone: "success" },
  suspended: { label: "Suspended", tone: "warning" },
  revoked: { label: "Revoked", tone: "destructive" },
};

export function connectionStatusMeta(status: IntegrationConnectionStatus): ConnectionStatusMeta {
  return CONNECTION_STATUS_META[status] ?? { label: status, tone: "default" };
}

/** Human name for a connection's provider ("GitHub", "Slack", …). */
export function connectionProviderName(
  connection: Pick<PublicConnection, "provider">,
): string {
  switch (connection.provider) {
    case "github":
      return "GitHub";
    case "slack":
      return "Slack";
    case "cloudflare":
      return "Cloudflare";
    case "supabase":
      return "Supabase";
    default:
      return connection.provider;
  }
}

/** Display name for a connection row: label > account login > provider. */
export function connectionDisplayName(connection: PublicConnection): string {
  return (
    connection.displayName ??
    connection.externalAccountLogin ??
    `${connectionProviderName(connection)} connection`
  );
}

/**
 * Rows worth showing in the settings list: everything except revoked rows
 * older than the newest revocation (history belongs to the audit log, but the
 * most recent revoked row stays visible so a revoke has an immediate,
 * confirmable result).
 */
export function visibleConnections(connections: PublicConnection[]): PublicConnection[] {
  const live = connections.filter((c) => c.status !== "revoked");
  const revoked = connections.filter((c) => c.status === "revoked");
  return revoked.length > 0 ? [...live, revoked[0]!] : live;
}

/** True while a connect popup flow should keep polling the list. */
export function hasPendingConnection(connections: PublicConnection[]): boolean {
  return connections.some((c) => c.status === "pending");
}

// ── Tenancy surfacing (saas-integration-tenancy IT5) ────────
// Make the connection's ownership scope and admission posture legible, and
// disclose the uninstall blast radius — so an account admin understands that one
// shared connection serves every workspace under the account.

export interface ConnectionScopeMeta {
  label: string;
  /** One-line explanation shown under the connection row. */
  description: string;
}

export function connectionScopeMeta(scope: IntegrationConnectionScope): ConnectionScopeMeta {
  return scope === "workspace"
    ? {
        label: "Workspace-private",
        description: "Private to this workspace — its own provider account, not shared with the rest of the account.",
      }
    : {
        label: "Account-shared",
        description: "Serves the whole account — every workspace under it can use this connection.",
      };
}

export interface ConnectionShareModeMeta {
  label: string;
  description: string;
}

/**
 * Admission posture, meaningful only for account-shared connections. Returns
 * null for workspace-private connections (admission does not apply).
 */
export function connectionShareModeMeta(
  connection: Pick<PublicConnection, "scope" | "shareMode">,
): ConnectionShareModeMeta | null {
  if (connection.scope !== "account") return null;
  const mode: IntegrationConnectionShareMode = connection.shareMode;
  return mode === "granted"
    ? {
        label: "By invitation",
        description: "Only workspaces the account has granted may use this connection.",
      }
    : {
        label: "Open to all workspaces",
        description: "Every workspace under the account may use this connection.",
      };
}

/**
 * Blast-radius disclosure for the revoke/uninstall confirmation. An
 * account-shared connection removes the provider for the whole account; a
 * workspace-private one affects only that workspace.
 */
export function uninstallDisclosure(
  connection: Pick<PublicConnection, "scope" | "provider">,
): string {
  if (connection.provider === "slack") {
    return connection.scope === "account"
      ? "This connection serves the whole account. Revoking it deletes the workspace's bot token, revokes it with Slack, and stops Slack notifications for every workspace using it."
      : "Revoking disconnects this Slack workspace: the bot token is deleted and revoked with Slack, and channels backed by this connection stop receiving notifications.";
  }
  if (connection.provider === "cloudflare") {
    return connection.scope === "account"
      ? "This connection serves the whole account. Revoking it revokes every live minted child token, zeroizes the parent token in custody, and brokered secrets that depend on it fail closed for every workspace."
      : "Revoking disconnects this Cloudflare account: live minted child tokens are revoked, the parent token in custody is zeroized, and brokered secrets that depend on this connection fail closed.";
  }
  if (connection.provider === "supabase") {
    return connection.scope === "account"
      ? "This connection serves the whole account. Revoking it revokes and zeroizes the refresh token, revokes live minted access tokens, and brokered secrets that depend on it fail closed for every workspace."
      : "Revoking disconnects this Supabase organization: the refresh token is revoked and zeroized, live minted access tokens are revoked, and brokered secrets that depend on this connection fail closed.";
  }
  return connection.scope === "account"
    ? "This connection serves the whole account. Revoking it uninstalls the GitHub App for this account and stops events and token issuance for every workspace's linked repositories."
    : "The platform stops receiving events for this installation and any linked repositories stop updating. This also uninstalls the App from GitHub when possible.";
}
