// IR2 (epic risks R2): the `[slug]` resolver handles exactly two shapes, and
// no provider id can ever collide with the connection-id shape or a reserved
// nested segment — enumerated against the contracts' provider-id set so a
// future provider id that would break routing fails HERE, not in production.

import { INTEGRATION_PROVIDER_DESCRIPTORS } from "@saas/contracts/integrations";
import {
  CONNECTION_ID_RE,
  RESERVED_SLUG_SEGMENTS,
  resolveIntegrationSlug,
} from "@web-console-next/components/integrations/route-model";

describe("integration slug resolution (IR2)", () => {
  it("routes int_<32hex> to the connection redirect", () => {
    const id = `int_${"a".repeat(32)}`;
    expect(resolveIntegrationSlug(id)).toEqual({ kind: "connection", connectionId: id });
  });

  it("routes everything else as a provider id (the space 404s unknowns)", () => {
    expect(resolveIntegrationSlug("cloudflare")).toEqual({
      kind: "provider",
      providerId: "cloudflare",
    });
    // Shape is strict: wrong length / case / prefix is NOT a connection.
    expect(resolveIntegrationSlug("int_123").kind).toBe("provider");
    expect(resolveIntegrationSlug(`INT_${"a".repeat(32)}`).kind).toBe("provider");
  });

  it("no contract provider id collides with the connection shape or reserved segments", () => {
    for (const id of Object.keys(INTEGRATION_PROVIDER_DESCRIPTORS)) {
      expect(CONNECTION_ID_RE.test(id)).toBe(false);
      expect(RESERVED_SLUG_SEGMENTS as readonly string[]).not.toContain(id);
      // Provider ids must be plain lowercase slugs — the [slug] segment's
      // provider branch assumes it.
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
