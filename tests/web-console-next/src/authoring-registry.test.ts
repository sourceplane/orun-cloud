// saas-secrets-platform SP1: the Secret Authoring Interface.
//
// Asserts (1) the authoring-surface registry resolves the default surface —
// since IR4 the outcome-first SecretWizardSurface — for every provider and
// honors a custom graft (the SP2 seam), and (2) the frozen SDK authoring
// contract — the three create calls — exists with stable names
// (capability-contract §5). Pure-logic tests: components are compared by
// identity, never rendered (no jsdom in this suite).

import {
  authoringSurfaceFor,
  hasCustomAuthoring,
  registerCustomAuthoring,
  type AuthoringSurface,
} from "@web-console-next/components/config/authoring-registry";
import { SecretWizardSurface } from "@web-console-next/components/config/secret-wizard";
import { ConfigClient } from "@saas/sdk";

describe("authoringSurfaceFor (SP1 registry)", () => {
  it("resolves the default wizard surface for every provider with no custom graft", () => {
    for (const provider of ["cloudflare", "supabase", "github", "aws", "unknown-provider"]) {
      expect(authoringSurfaceFor(provider)).toBe(SecretWizardSurface);
      expect(hasCustomAuthoring(provider)).toBe(false);
    }
  });

  it("honors a registered custom surface and falls back after unregister", () => {
    const Custom: AuthoringSurface = () => null;
    const unregister = registerCustomAuthoring("cloudflare", Custom);
    try {
      expect(authoringSurfaceFor("cloudflare")).toBe(Custom);
      expect(hasCustomAuthoring("cloudflare")).toBe(true);
      // Other providers are untouched by the graft.
      expect(authoringSurfaceFor("supabase")).toBe(SecretWizardSurface);
    } finally {
      unregister();
    }
    expect(authoringSurfaceFor("cloudflare")).toBe(SecretWizardSurface);
    expect(hasCustomAuthoring("cloudflare")).toBe(false);
  });

  it("last registration wins; unregister only removes its own surface", () => {
    const First: AuthoringSurface = () => null;
    const Second: AuthoringSurface = () => null;
    const unregisterFirst = registerCustomAuthoring("supabase", First);
    const unregisterSecond = registerCustomAuthoring("supabase", Second);
    try {
      expect(authoringSurfaceFor("supabase")).toBe(Second);
      // First's unregister is a no-op — it no longer owns the slot.
      unregisterFirst();
      expect(authoringSurfaceFor("supabase")).toBe(Second);
    } finally {
      unregisterSecond();
    }
    expect(authoringSurfaceFor("supabase")).toBe(SecretWizardSurface);
  });
});

describe("the frozen SDK authoring contract (SP1, capability-contract §5)", () => {
  it("exposes createSecretMetadata / createBrokeredSecret / createRotatedSecret", () => {
    expect(typeof ConfigClient.prototype.createSecretMetadata).toBe("function");
    expect(typeof ConfigClient.prototype.createBrokeredSecret).toBe("function");
    expect(typeof ConfigClient.prototype.createRotatedSecret).toBe("function");
  });
});
