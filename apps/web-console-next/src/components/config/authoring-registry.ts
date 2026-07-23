/**
 * The per-provider authoring-surface registry (saas-secrets-platform SP1,
 * capability-contract §6) — the same graft-point pattern as the worker's
 * `getConfiguredProvider`:
 *
 *   - a provider with a registered CUSTOM surface renders its own create
 *     experience in its own space (SP2), built on the SP1 primitives;
 *   - every other provider inherits the default surface — since IR4 the
 *     outcome-first `SecretWizardSurface` (`secret-wizard.tsx`), rendered
 *     from its SP0 capability declaration — zero UI code for a new provider.
 *
 * The declaration's `authoring: "declarative" | "custom"` field is the
 * provider's INTENT; this registry is the console-side resolution. A declared
 * "custom" with no registered surface falls back to the default (fail-open to
 * a working create flow, never a dead end — SP-A3).
 */

import type * as React from "react";
import { SecretWizardSurface, type AuthoringSurfaceProps } from "./secret-wizard";

export type AuthoringSurface = React.ComponentType<AuthoringSurfaceProps>;

/** Custom surfaces, keyed by provider id. SP2 registers Cloudflare's here. */
const CUSTOM_AUTHORING: Record<string, AuthoringSurface> = {};

/** Resolve the authoring surface for a provider (custom graft, else the
 *  default outcome-first wizard). */
export function authoringSurfaceFor(providerId: string): AuthoringSurface {
  return CUSTOM_AUTHORING[providerId] ?? SecretWizardSurface;
}

/** True when the provider has a registered custom surface. */
export function hasCustomAuthoring(providerId: string): boolean {
  return providerId in CUSTOM_AUTHORING;
}

/**
 * Register a provider's custom authoring surface (SP2). Module-load-time
 * registration; re-registering replaces (last wins) so a provider space can
 * hot-swap its surface in isolation. Returns an unregister for tests.
 */
export function registerCustomAuthoring(providerId: string, surface: AuthoringSurface): () => void {
  CUSTOM_AUTHORING[providerId] = surface;
  return () => {
    if (CUSTOM_AUTHORING[providerId] === surface) delete CUSTOM_AUTHORING[providerId];
  };
}
