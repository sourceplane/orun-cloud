/**
 * Pure logic for the per-provider integration space
 * (saas-secrets-platform SP2, design addendum SP-A2).
 *
 * Dependency-free (no React) so the space's routing, filtering, and mode
 * derivation are unit-testable in isolation. The React wiring lives in
 * `provider-space.tsx`.
 */

import type { PublicSecretMetadata } from "@saas/contracts/config";
import type { ProviderSecretsCapability, SecretMode } from "@saas/contracts/integrations";
import { deriveBrokerRow, deriveRotationRow } from "@/components/config/bind-secret-flow";

/** The integration's canonical route (IR2, was the SP-A2 `providers/` path —
 *  which now redirects here) — every "managed by {integration}" deep link
 *  lands here. */
export function providerSpaceHref(orgSlug: string, providerId: string): string {
  return `/orgs/${orgSlug}/integrations/${providerId}`;
}

/** The provider space's create deep-link: pre-selects (and locks) a
 *  connection in the create dialog — the SP-A4 successor of the Secrets
 *  page's `?bind=1&connection=`. */
export function providerSpaceCreateHref(
  orgSlug: string,
  providerId: string,
  connectionId?: string,
): string {
  const base = `${providerSpaceHref(orgSlug, providerId)}?create=1`;
  return connectionId ? `${base}&connection=${connectionId}` : base;
}

/** The provider's declared capability from the bulk read; null when the
 *  provider is not a secret source. */
export function capabilityForProvider(
  capabilities: readonly ProviderSecretsCapability[],
  providerId: string,
): ProviderSecretsCapability | null {
  return capabilities.find((c) => c.provider === providerId) ?? null;
}

/** The subset of secrets this provider's connections produced — the owner's
 *  own footprint (ownership-model §Surface 2): brokered rows bound to it and
 *  rotated rows minted from it. */
export function providerBoundSecrets<T extends Pick<PublicSecretMetadata, "source" | "binding" | "rotation">>(
  secrets: readonly T[],
  providerId: string,
): T[] {
  return secrets.filter((s) => {
    const broker = deriveBrokerRow(s);
    if (broker?.provider === providerId) return true;
    const rotation = deriveRotationRow(s);
    return rotation?.provider === providerId;
  });
}

/**
 * The Secrets page's "New secret" menu (SP3, SP-A3): one routed item per
 * capability-declaring provider, deep-linking to the owner's create surface.
 * Derived from the bulk read — never a hardcoded list. Providers appear even
 * without a live connection: the space owns the connect CTA, so creation
 * still STARTS at the owner.
 */
export function integrationCreateMenu(
  capabilities: readonly ProviderSecretsCapability[],
  orgSlug: string,
  providerNameFor: (providerId: string) => string = (id) => id,
): Array<{ providerId: string; label: string; href: string }> {
  return capabilities.map((c) => ({
    providerId: c.provider,
    label: `From ${providerNameFor(c.provider)}…`,
    href: providerSpaceCreateHref(orgSlug, c.provider),
  }));
}

/**
 * SP-A4: the legacy `?bind=1[&connection=int_…]` Secrets-page deep link
 * migrates to the owning provider space. With a connection id we resolve its
 * provider from the (already-fetched) connections list and land on that
 * space's create dialog with the connection pre-selected; without one (or
 * when the connection is unknown) the hub is the honest owner-of-owners.
 */
export function legacyBindRedirect(
  orgSlug: string,
  connectionId: string | null,
  connections: ReadonlyArray<{ id: string; provider: string }>,
): string {
  if (connectionId) {
    const conn = connections.find((c) => c.id === connectionId);
    if (conn) return providerSpaceCreateHref(orgSlug, conn.provider, conn.id);
  }
  return `/orgs/${orgSlug}/integrations`;
}

/** Surface mode ("binding" | "rotated") for a declared SecretMode. */
export function surfaceModeFor(mode: SecretMode): "binding" | "rotated" {
  return mode === "rotated" ? "rotated" : "binding";
}

/** The create-dialog mode toggle the space renders: one entry per declared
 *  mode, in a stable order (brokered first — the cheaper, value-less kind). */
export function modeToggleFor(
  capability: ProviderSecretsCapability | null,
): Array<{ mode: "binding" | "rotated"; label: string }> {
  if (!capability) return [];
  const entries: Array<{ mode: "binding" | "rotated"; label: string }> = [];
  if (capability.supportedModes.includes("brokered")) {
    entries.push({ mode: "binding", label: "Scoped credential" });
  }
  if (capability.supportedModes.includes("rotated")) {
    entries.push({ mode: "rotated", label: "Rotated secret" });
  }
  return entries;
}
