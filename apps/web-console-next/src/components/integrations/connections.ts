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

// ── Lifecycle hardening (saas-integration-hub IH9, design §5.3) ────────
// A failed refresh (Supabase) or invalid parent token (Cloudflare) flips the
// connection to `suspended`; re-running the provider's connect flow
// REACTIVATES the existing row (same org + same external account/workspace →
// custody refresh + status active). The console affordance is therefore
// "Reconnect" — the provider's normal connect flow — not a new connection.

export interface ReauthAffordance {
  label: string;
  /** One-line explanation of why the connection is suspended and what reconnecting does. */
  description: string;
}

/**
 * Re-auth CTA for a suspended connection, or null when re-auth is not the
 * remedy. Only oauth/token-kind providers (Slack, Supabase, Cloudflare) get
 * the CTA; GitHub's lifecycle is webhook-driven (suspend/unsuspend/reinstall
 * arrive from GitHub itself), so reconnecting from the console is not the fix.
 */
export function reauthAffordance(
  connection: Pick<PublicConnection, "provider" | "status">,
): ReauthAffordance | null {
  if (connection.status !== "suspended") return null;
  switch (connection.provider) {
    case "supabase":
      return {
        label: "Reconnect",
        description:
          "The authorization expired or was revoked — reconnect to resume minting and brokered secrets.",
      };
    case "cloudflare":
      return {
        label: "Reconnect",
        description: "The parent token is invalid or expired — paste a fresh token to resume.",
      };
    case "slack":
      return {
        label: "Reconnect",
        description: "The workspace authorization was revoked — reconnect to resume delivery.",
      };
    default:
      return null;
  }
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

// ---------------------------------------------------------------------------
// Revoke referential guard (brokered-orphan-safety, Feature 2)
// ---------------------------------------------------------------------------

/** One brokered secret blocking a connection revoke, as echoed by the 409. */
export interface RevokeBlocker {
  id: string;
  secretKey: string;
  scope: string;
}

/** Structural subset of `ApiErrorBody` — kept local so this stays React-free. */
export interface RevokeErrorLike {
  reason?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

/**
 * Extract the blocking brokered secrets from a revoke failure. Returns the
 * blocker list ONLY for the referential-guard 409 (`connection_in_use`) —
 * every other error returns null so the caller falls back to a generic toast.
 * Defensive about a malformed `details.blockers` payload (drops bad entries).
 */
export function parseRevokeBlockers(error: RevokeErrorLike): RevokeBlocker[] | null {
  if (error.reason !== "connection_in_use") return null;
  const raw = error.details?.["blockers"];
  if (!Array.isArray(raw)) return [];
  const blockers: RevokeBlocker[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      if (typeof rec.id === "string" && typeof rec.secretKey === "string") {
        blockers.push({
          id: rec.id,
          secretKey: rec.secretKey,
          scope: typeof rec.scope === "string" ? rec.scope : "",
        });
      }
    }
  }
  return blockers;
}

/**
 * Whether a revoke failure is the fail-closed reference-check-unavailable case
 * (the platform could not confirm the connection is unused, so a non-forced
 * revoke was refused). The console offers the same force path as for blockers.
 */
export function isReferenceCheckUnavailable(error: RevokeErrorLike): boolean {
  return error.reason === "reference_check_unavailable";
}
