// Brokered-orphan derivation (brokered-orphan-safety, Feature 1).
import { deriveOrphan } from "@config-worker/orphan";

describe("deriveOrphan", () => {
  it("never orphans a static secret, whatever the connection status", () => {
    for (const s of ["active", "revoked", "suspended", "pending", "unknown", null, undefined] as const) {
      const v = deriveOrphan("static", s);
      expect(v.orphaned).toBe(false);
      expect(v.reason).toBe("healthy");
    }
  });

  it("treats undefined source as static (back-compat)", () => {
    expect(deriveOrphan(undefined, "revoked").orphaned).toBe(false);
  });

  it("is healthy when the brokered connection is active", () => {
    expect(deriveOrphan("brokered", "active")).toEqual({
      orphaned: false,
      bindingStatus: "active",
      reason: "healthy",
    });
  });

  it("orphans a brokered secret whose connection is revoked", () => {
    expect(deriveOrphan("brokered", "revoked")).toEqual({
      orphaned: true,
      bindingStatus: "revoked",
      reason: "connection_revoked",
    });
  });

  it("orphans on suspended and pending (cannot mint)", () => {
    expect(deriveOrphan("brokered", "suspended").reason).toBe("connection_suspended");
    expect(deriveOrphan("brokered", "pending").reason).toBe("connection_pending");
    expect(deriveOrphan("brokered", "suspended").orphaned).toBe(true);
    expect(deriveOrphan("brokered", "pending").orphaned).toBe(true);
  });

  it("never treats an unreadable/missing connection as healthy", () => {
    expect(deriveOrphan("brokered", "unknown")).toEqual({
      orphaned: true,
      bindingStatus: "unknown",
      reason: "connection_unknown",
    });
    expect(deriveOrphan("brokered", null).orphaned).toBe(true);
    expect(deriveOrphan("brokered", null).reason).toBe("connection_missing");
    expect(deriveOrphan("brokered", undefined).orphaned).toBe(true);
  });
});
