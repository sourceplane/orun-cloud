import type { ConnectionGrant, InboundDelivery, IntegrationConnection } from "@saas/db/integrations";
import type {
  PublicConnection,
  PublicConnectionGrant,
  PublicInboundDelivery,
  IntegrationProviderId,
} from "@saas/contracts/integrations";
import { connectionPublicId, inboundDeliveryPublicId, orgPublicId } from "./ids.js";

function isoOrNull(d: Date | null): string | null {
  return d == null ? null : d.toISOString();
}

/**
 * Safe projection: no installation id, no state fields, no timestamps the
 * contract doesn't declare. The repo layer already excludes the nonce hash.
 */
export function toPublicConnection(connection: IntegrationConnection): PublicConnection {
  return {
    id: connectionPublicId(connection.id),
    orgId: orgPublicId(connection.orgId),
    provider: connection.provider as IntegrationProviderId,
    status: connection.status,
    scope: connection.scope,
    shareMode: connection.shareMode,
    displayName: connection.displayName,
    externalAccountLogin: connection.externalAccountLogin,
    externalAccountType: connection.externalAccountType,
    repositorySelection: null,
    createdBy: connection.createdBy,
    connectedAt: isoOrNull(connection.connectedAt),
    revokedAt: isoOrNull(connection.revokedAt),
    suspendedAt: isoOrNull(connection.suspendedAt),
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
    ...(connection.capabilityPrefs ? { capabilityPrefs: connection.capabilityPrefs } : {}),
  };
}

/** Variant carrying the installation's repository selection when loaded. */
export function toPublicConnectionWithSelection(
  connection: IntegrationConnection,
  repositorySelection: string | null,
): PublicConnection {
  return { ...toPublicConnection(connection), repositorySelection };
}

/**
 * Project an Account's `account`-scoped connection as **inherited** for a child
 * workspace (IT10): read-only, attributed to the owning Account by `ws_…` + name.
 */
export function toInheritedPublicConnection(
  connection: IntegrationConnection,
  account: { workspaceRef: string; name: string },
): PublicConnection {
  return {
    ...toPublicConnection(connection),
    inherited: true,
    sharedByWorkspaceRef: account.workspaceRef,
    sharedByName: account.name,
  };
}

export function toPublicConnectionGrant(grant: ConnectionGrant): PublicConnectionGrant {
  return {
    connectionId: connectionPublicId(grant.connectionId),
    workspaceOrgId: orgPublicId(grant.orgId),
    grantedBy: grant.grantedBy,
    status: grant.status,
    grantedAt: grant.grantedAt.toISOString(),
    revokedAt: isoOrNull(grant.revokedAt),
  };
}

/**
 * Safe projection of an inbox row: never the raw payload (admin-only) and
 * never the delivery key beyond what the provider already knows.
 */
export function toPublicInboundDelivery(delivery: InboundDelivery): PublicInboundDelivery {
  return {
    id: inboundDeliveryPublicId(delivery.id),
    provider: delivery.provider as IntegrationProviderId,
    eventType: delivery.eventType,
    action: delivery.action,
    status: delivery.status,
    signatureOk: delivery.signatureOk,
    attempts: delivery.attempts,
    failureReason: delivery.failureReason,
    emittedEventId: delivery.emittedEventId,
    receivedAt: delivery.receivedAt.toISOString(),
  };
}
