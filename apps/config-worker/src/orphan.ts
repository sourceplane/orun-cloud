// Brokered-orphan derivation (brokered-orphan-safety, Feature 1).
//
// A brokered secret is a pointer at an integration connection; its value is
// minted at resolve time. So its health is a *projection* of the connection's
// lifecycle — computed here at read time, never stored, so it can never drift
// the way the secret's own `status` column does. Every surface (console,
// `orun secrets`, plan, run) renders the result of this one function.

export type BindingStatus =
  | "active"
  | "pending"
  | "suspended"
  | "revoked"
  | "unknown";

export type OrphanReason =
  | "healthy"
  | "connection_revoked"
  | "connection_suspended"
  | "connection_pending"
  | "connection_missing"
  | "connection_unknown";

export interface OrphanVerdict {
  /** True when the brokered secret can no longer mint (connection not active). */
  orphaned: boolean;
  bindingStatus: BindingStatus;
  /** Stable machine reason for logs, CLI copy, and the run-time resolve error. */
  reason: OrphanReason;
}

/**
 * Derive orphan health for a secret.
 *
 * - Static secrets are never orphaned.
 * - A brokered secret is orphaned unless its connection is `active` — the same
 *   predicate the mint guard enforces (`connection.status !== "active"` fails).
 * - `connStatus === null | undefined` means the connection row is gone entirely
 *   (`connection_missing`); a literal `"unknown"` means the status could not be
 *   read (`connection_unknown`). Both are orphaned — we never treat an
 *   unreadable connection as healthy.
 */
export function deriveOrphan(
  source: string | null | undefined,
  connStatus: BindingStatus | null | undefined,
): OrphanVerdict {
  if (source !== "brokered") {
    return { orphaned: false, bindingStatus: "active", reason: "healthy" };
  }
  switch (connStatus) {
    case "active":
      return { orphaned: false, bindingStatus: "active", reason: "healthy" };
    case "revoked":
      return { orphaned: true, bindingStatus: "revoked", reason: "connection_revoked" };
    case "suspended":
      return { orphaned: true, bindingStatus: "suspended", reason: "connection_suspended" };
    case "pending":
      return { orphaned: true, bindingStatus: "pending", reason: "connection_pending" };
    case "unknown":
      return { orphaned: true, bindingStatus: "unknown", reason: "connection_unknown" };
    default:
      return { orphaned: true, bindingStatus: "unknown", reason: "connection_missing" };
  }
}
