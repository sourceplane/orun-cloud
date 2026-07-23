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

/** The provider space route (SP-A2) — every "managed by {integration}" deep
 *  link lands here. */
export function providerSpaceHref(orgSlug: string, providerId: string): string {
  return `/orgs/${orgSlug}/integrations/providers/${providerId}`;
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
