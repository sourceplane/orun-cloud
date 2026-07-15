// brokered-orphan-safety (Feature 1): list-path stamping.
import { stampOrphaned } from "@config-worker/orphan-stamp";
import type { PublicSecretMetadata } from "@saas/contracts/config";

function base(key: string): PublicSecretMetadata {
  return {
    id: `sec_${key}`,
    orgId: "org_1",
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: key,
    displayName: null,
    status: "active",
    version: 1,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: "u",
    createdAt: "t",
    updatedAt: "t",
  };
}
function brokered(key: string, connectionId: string): PublicSecretMetadata {
  return {
    ...base(key),
    source: "brokered",
    binding: { provider: "supabase", connectionId, template: "management-access" },
  };
}

describe("stampOrphaned", () => {
  it("marks brokered secrets orphaned when their connection is revoked", async () => {
    const out = await stampOrphaned([brokered("A", "int_a")], async () => ({
      ok: true,
      statuses: { int_a: "revoked" },
    }));
    expect(out[0]!.orphaned).toBe(true);
    expect(out[0]!.bindingStatus).toBe("revoked");
  });

  it("keeps brokered healthy when the connection is active", async () => {
    const out = await stampOrphaned([brokered("A", "int_a")], async () => ({
      ok: true,
      statuses: { int_a: "active" },
    }));
    expect(out[0]!.orphaned).toBe(false);
    expect(out[0]!.bindingStatus).toBe("active");
  });

  it("treats a connection absent from the map as missing (orphaned)", async () => {
    const out = await stampOrphaned([brokered("A", "int_a")], async () => ({ ok: true, statuses: {} }));
    expect(out[0]!.orphaned).toBe(true);
    expect(out[0]!.bindingStatus).toBe("unknown");
  });

  it("leaves rows unstamped when the lookup is unreachable (health unknown, not orphaned)", async () => {
    const out = await stampOrphaned([brokered("A", "int_a")], async () => ({ ok: false }));
    expect(out[0]!.orphaned).toBeUndefined();
    expect(out[0]!.bindingStatus).toBeUndefined();
  });

  it("passes static secrets through untouched and never calls the lookup", async () => {
    let called = false;
    const out = await stampOrphaned([base("S")], async () => {
      called = true;
      return { ok: true, statuses: {} };
    });
    expect(called).toBe(false);
    expect(out[0]!.orphaned).toBeUndefined();
  });
});
