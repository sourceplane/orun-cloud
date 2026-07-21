// RS0 (provider-rotated-secrets): the pure rotation-producer validator that the
// create/update handlers (RS1) share with the 870 migration guards.

import { validateRotationProducer, ALLOWED_ROTATION_PROVIDERS } from "@saas/db/config";

const CONN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("validateRotationProducer (RS0)", () => {
  it("accepts a minimal cloudflare producer", () => {
    const r = validateRotationProducer({ provider: "cloudflare", connectionId: CONN, template: "workers-deploy" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.provider).toBe("cloudflare");
      expect(r.value.connectionId).toBe(CONN);
      expect(r.value.template).toBe("workers-deploy");
      expect(r.value.params).toBeUndefined();
    }
  });

  it("accepts optional params, graceSeconds, and deliverTarget", () => {
    const r = validateRotationProducer({
      provider: "cloudflare",
      connectionId: CONN,
      template: "dns-edit",
      params: { zoneIds: ["abc"] },
      graceSeconds: 3600,
      deliverTarget: "cloudflare-worker:api-prod",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.params).toEqual({ zoneIds: ["abc"] });
      expect(r.value.graceSeconds).toBe(3600);
      expect(r.value.deliverTarget).toBe("cloudflare-worker:api-prod");
    }
  });

  it("only ships cloudflare as an allowed provider in v1", () => {
    expect([...ALLOWED_ROTATION_PROVIDERS]).toEqual(["cloudflare"]);
  });

  it("rejects an unknown provider", () => {
    const r = validateRotationProducer({ provider: "vercel", connectionId: CONN, template: "t" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/provider/);
  });

  it("rejects a non-uuid connectionId", () => {
    const r = validateRotationProducer({ provider: "cloudflare", connectionId: "not-a-uuid", template: "t" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/connectionId/);
  });

  it("rejects an empty template", () => {
    const r = validateRotationProducer({ provider: "cloudflare", connectionId: CONN, template: "  " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/template/);
  });

  it("rejects a negative or non-integer graceSeconds", () => {
    expect(validateRotationProducer({ provider: "cloudflare", connectionId: CONN, template: "t", graceSeconds: -1 }).ok).toBe(false);
    expect(validateRotationProducer({ provider: "cloudflare", connectionId: CONN, template: "t", graceSeconds: 1.5 }).ok).toBe(false);
  });

  it("rejects params that are not a plain object", () => {
    const r = validateRotationProducer({ provider: "cloudflare", connectionId: CONN, template: "t", params: ["x"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/params/);
  });

  it("rejects an empty deliverTarget when set", () => {
    const r = validateRotationProducer({ provider: "cloudflare", connectionId: CONN, template: "t", deliverTarget: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/deliverTarget/);
  });

  it("rejects a non-object input", () => {
    expect(validateRotationProducer(null).ok).toBe(false);
    expect(validateRotationProducer("nope").ok).toBe(false);
  });
});
