import {
  brokerConnections,
  brokeredCreateErrorMessage,
  deriveBrokerRow,
  deriveRotationRow,
  isBrokerCapableProvider,
  orphanView,
  orphanedSecrets,
  validateBindingForm,
  validateRotationForm,
  CONNECTION_ID_PATTERN,
  type BindTemplateLike,
} from "@web-console-next/components/config/bind-secret-flow";

const CONNECTION_ID = `int_${"a".repeat(32)}`;

const TEMPLATES: BindTemplateLike[] = [
  { id: "workers-deploy", params: [] },
  { id: "dns-edit", params: ["zoneIds"] },
];

describe("connection id pattern", () => {
  it("accepts int_<32hex> only", () => {
    expect(CONNECTION_ID_PATTERN.test(CONNECTION_ID)).toBe(true);
    expect(CONNECTION_ID_PATTERN.test("int_" + "a".repeat(31))).toBe(false);
    expect(CONNECTION_ID_PATTERN.test("int_" + "A".repeat(32))).toBe(false);
    expect(CONNECTION_ID_PATTERN.test("sec_" + "a".repeat(32))).toBe(false);
    expect(CONNECTION_ID_PATTERN.test("")).toBe(false);
  });
});

describe("brokerConnections", () => {
  it("keeps only active, broker-capable connections", () => {
    const conns = [
      { id: "1", provider: "cloudflare", status: "active" },
      { id: "2", provider: "supabase", status: "active" },
      { id: "3", provider: "cloudflare", status: "revoked" },
      { id: "4", provider: "github", status: "active" },
      { id: "5", provider: "slack", status: "active" },
    ];
    expect(brokerConnections(conns).map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("knows the broker-capable provider set", () => {
    expect(isBrokerCapableProvider("cloudflare")).toBe(true);
    expect(isBrokerCapableProvider("supabase")).toBe(true);
    expect(isBrokerCapableProvider("github")).toBe(false);
    expect(isBrokerCapableProvider("slack")).toBe(false);
  });
});

describe("validateBindingForm", () => {
  const base = {
    secretKey: "CF_TOKEN",
    displayName: "",
    connectionId: CONNECTION_ID,
    template: "workers-deploy",
    params: {},
  };

  it("shapes a CreateBrokeredSecretRequest (no params key for a param-less template)", () => {
    const r = validateBindingForm(base, TEMPLATES);
    expect(r).toEqual({
      ok: true,
      request: {
        secretKey: "CF_TOKEN",
        binding: { connectionId: CONNECTION_ID, template: "workers-deploy" },
      },
    });
  });

  it("includes trimmed params and displayName when present", () => {
    const r = validateBindingForm(
      { ...base, template: "dns-edit", params: { zoneIds: " z1,z2 " }, displayName: " DNS token " },
      TEMPLATES,
    );
    expect(r).toEqual({
      ok: true,
      request: {
        secretKey: "CF_TOKEN",
        binding: { connectionId: CONNECTION_ID, template: "dns-edit", params: { zoneIds: "z1,z2" } },
        displayName: "DNS token",
      },
    });
  });

  it("applies the secretKey rule (1..128 after trim)", () => {
    expect(validateBindingForm({ ...base, secretKey: "  " }, TEMPLATES)).toEqual({
      ok: false,
      errors: { secretKey: "Required" },
    });
    expect(validateBindingForm({ ...base, secretKey: "x".repeat(129) }, TEMPLATES).ok).toBe(false);
    expect(validateBindingForm({ ...base, secretKey: "x".repeat(128) }, TEMPLATES).ok).toBe(true);
  });

  it("rejects malformed connection ids and unknown templates", () => {
    const r = validateBindingForm({ ...base, connectionId: "int_nope", template: "made-up" }, TEMPLATES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.connectionId).toBe("Pick a connection");
      expect(r.errors.template).toBe("Pick a scope template");
    }
  });

  it("requires every param the chosen template declares", () => {
    const r = validateBindingForm({ ...base, template: "dns-edit", params: { zoneIds: "" } }, TEMPLATES);
    expect(r).toEqual({ ok: false, errors: { zoneIds: "Required" } });
  });

  it("bounds displayName at 128", () => {
    const r = validateBindingForm({ ...base, displayName: "x".repeat(129) }, TEMPLATES);
    expect(r.ok).toBe(false);
  });

  it("carries a valid rotation cadence into the request (SC2)", () => {
    const r = validateBindingForm({ ...base, rotationPolicy: "90d" }, TEMPLATES);
    expect(r).toEqual({
      ok: true,
      request: {
        secretKey: "CF_TOKEN",
        binding: { connectionId: CONNECTION_ID, template: "workers-deploy" },
        rotationPolicy: "90d",
      },
    });
  });

  it("omits an empty cadence and rejects a malformed one (SC2)", () => {
    expect(validateBindingForm({ ...base, rotationPolicy: "" }, TEMPLATES)).toEqual({
      ok: true,
      request: { secretKey: "CF_TOKEN", binding: { connectionId: CONNECTION_ID, template: "workers-deploy" } },
    });
    const bad = validateBindingForm({ ...base, rotationPolicy: "soon" }, TEMPLATES);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.rotationPolicy).toMatch(/duration/i);
  });
});

describe("deriveBrokerRow", () => {
  it("returns null for static rows (absent or explicit source)", () => {
    expect(deriveBrokerRow({})).toBeNull();
    expect(deriveBrokerRow({ source: "static" })).toBeNull();
  });

  it("returns provenance for a brokered row", () => {
    expect(
      deriveBrokerRow({
        source: "brokered",
        binding: { provider: "cloudflare", connectionId: CONNECTION_ID, template: "workers-deploy" },
      }),
    ).toEqual({
      provider: "cloudflare",
      template: "workers-deploy",
      connectionId: CONNECTION_ID,
      label: "brokered · cloudflare · workers-deploy",
    });
  });

  it("is defensive about a brokered row missing its binding facts", () => {
    expect(deriveBrokerRow({ source: "brokered" })).toBeNull();
  });
});

describe("orphanView", () => {
  it("returns null for static rows", () => {
    expect(orphanView({ source: "static" })).toBeNull();
    expect(orphanView({})).toBeNull();
  });

  it("returns null for a brokered row the server did not stamp (health unknown)", () => {
    // No orphaned / bindingStatus present → the status lookup was unreachable;
    // never asserted orphaned on doubt.
    expect(orphanView({ source: "brokered" })).toBeNull();
  });

  it("marks an orphaned brokered row with its status and a run-time-failure reason", () => {
    const v = orphanView({ source: "brokered", orphaned: true, bindingStatus: "revoked" });
    expect(v).not.toBeNull();
    expect(v!.orphaned).toBe(true);
    expect(v!.label).toBe("orphaned");
    expect(v!.bindingStatus).toBe("revoked");
    expect(v!.reason).toContain("revoked");
    expect(v!.reason).toMatch(/fail to resolve/i);
  });

  it("special-cases a missing connection (bindingStatus unknown)", () => {
    const v = orphanView({ source: "brokered", orphaned: true, bindingStatus: "unknown" });
    expect(v!.reason).toMatch(/no longer exists/i);
  });

  it("reports a healthy brokered row without asserting orphaned", () => {
    const v = orphanView({ source: "brokered", orphaned: false, bindingStatus: "active" });
    expect(v!.orphaned).toBe(false);
    expect(v!.label).toBe("active");
  });
});

describe("orphanedSecrets", () => {
  it("keeps only the orphaned brokered rows", () => {
    const rows = [
      { secretKey: "A", source: "brokered" as const, orphaned: true, bindingStatus: "revoked" as const },
      { secretKey: "B", source: "brokered" as const, orphaned: false, bindingStatus: "active" as const },
      { secretKey: "C", source: "static" as const },
      { secretKey: "D", source: "brokered" as const }, // unstamped — health unknown
    ];
    expect(orphanedSecrets(rows).map((r) => r.secretKey)).toEqual(["A"]);
  });
});

describe("brokeredCreateErrorMessage", () => {
  it("renders limit_reached with the entitlement key and usage", () => {
    const msg = brokeredCreateErrorMessage({
      message: "precondition failed",
      reason: "limit_reached",
      details: { key: "limit.brokered_secrets", limit: 3, current: 3 },
    });
    expect(msg).toBe("Your plan's brokered secrets limit is reached (3 of 3 used). Upgrade your plan to bind more secrets.");
  });

  it("renders limit_reached without usage details", () => {
    const msg = brokeredCreateErrorMessage({ message: "precondition failed", reason: "limit_reached" });
    expect(msg).toBe("Your plan's brokered secrets limit is reached. Upgrade your plan to bind more secrets.");
  });

  it("renders not_configured and disabled", () => {
    expect(
      brokeredCreateErrorMessage({ message: "m", reason: "not_configured", details: { key: "limit.brokered_secrets" } }),
    ).toContain("Billing isn't configured");
    expect(brokeredCreateErrorMessage({ message: "m", reason: "disabled" })).toContain("disabled on your plan");
  });

  it("falls back to the server message for unknown reasons", () => {
    expect(brokeredCreateErrorMessage({ message: "kaboom" })).toBe("kaboom");
    expect(brokeredCreateErrorMessage({ message: "kaboom", reason: "weird" })).toBe("kaboom");
  });
});

describe("deriveRotationRow (provider-rotated-secrets RS4)", () => {
  it("returns null for non-rotated rows", () => {
    expect(deriveRotationRow({})).toBeNull();
    expect(deriveRotationRow({ rotationPolicy: "30d" })).toBeNull();
  });

  it("derives the producer provenance with the cadence", () => {
    expect(
      deriveRotationRow({
        rotationPolicy: "30d",
        rotation: {
          provider: "cloudflare",
          connectionId: "int_" + "cd".repeat(16),
          template: "workers-deploy",
          graceSeconds: null,
          deliverTarget: null,
        },
      }),
    ).toEqual({
      provider: "cloudflare",
      template: "workers-deploy",
      connectionId: "int_" + "cd".repeat(16),
      deliverTarget: null,
      label: "rotated · cloudflare · workers-deploy · every 30d",
    });
  });

  it("omits the cadence segment when no policy is set and carries the deliver target", () => {
    const row = deriveRotationRow({
      rotation: {
        provider: "cloudflare",
        connectionId: "int_" + "cd".repeat(16),
        template: "workers-deploy",
        graceSeconds: 3600,
        deliverTarget: "cloudflare-worker:api-prod",
      },
    });
    expect(row?.label).toBe("rotated · cloudflare · workers-deploy");
    expect(row?.deliverTarget).toBe("cloudflare-worker:api-prod");
  });
});

describe("validateRotationForm (provider-rotated-secrets RS4)", () => {
  const templates: BindTemplateLike[] = [
    { id: "workers-deploy", params: [] },
    { id: "dns-edit", params: ["zoneIds"] },
  ];
  const conn = "int_" + "cd".repeat(16);

  it("shapes a createRotatedSecret body with rotation (not binding)", () => {
    const r = validateRotationForm(
      { secretKey: "CF_TOKEN", displayName: "", connectionId: conn, template: "workers-deploy", params: {}, rotationPolicy: "30d" },
      templates,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.rotation).toEqual({ connectionId: conn, template: "workers-deploy" });
      expect(r.request.rotationPolicy).toBe("30d");
      // A rotated create must NOT carry a brokered binding or a value.
      expect((r.request as unknown as Record<string, unknown>).binding).toBeUndefined();
      expect((r.request as unknown as Record<string, unknown>).value).toBeUndefined();
    }
  });

  it("carries template params, a valid graceSeconds, and deliverTarget", () => {
    const r = validateRotationForm(
      {
        secretKey: "CF_TOKEN",
        displayName: "",
        connectionId: conn,
        template: "dns-edit",
        params: { zoneIds: "z1" },
        rotationPolicy: "",
        graceSeconds: "3600",
        deliverTarget: "cloudflare-worker:api-prod",
      },
      templates,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.rotation).toEqual({
        connectionId: conn,
        template: "dns-edit",
        params: { zoneIds: "z1" },
        graceSeconds: 3600,
        deliverTarget: "cloudflare-worker:api-prod",
      });
      // Empty policy is valid — the server defaults it to 30d.
      expect(r.request.rotationPolicy).toBeUndefined();
    }
  });

  it("rejects a bad connection, a missing param, a non-integer grace, and a bad policy", () => {
    const badConn = validateRotationForm(
      { secretKey: "K", displayName: "", connectionId: "nope", template: "workers-deploy", params: {}, rotationPolicy: "" },
      templates,
    );
    expect(badConn.ok).toBe(false);
    if (!badConn.ok) expect(badConn.errors.connectionId).toBeDefined();

    const missingParam = validateRotationForm(
      { secretKey: "K", displayName: "", connectionId: conn, template: "dns-edit", params: {}, rotationPolicy: "" },
      templates,
    );
    expect(missingParam.ok).toBe(false);
    if (!missingParam.ok) expect(missingParam.errors.zoneIds).toBeDefined();

    const badGrace = validateRotationForm(
      { secretKey: "K", displayName: "", connectionId: conn, template: "workers-deploy", params: {}, rotationPolicy: "", graceSeconds: "-5" },
      templates,
    );
    expect(badGrace.ok).toBe(false);
    if (!badGrace.ok) expect(badGrace.errors.graceSeconds).toBeDefined();

    const badPolicy = validateRotationForm(
      { secretKey: "K", displayName: "", connectionId: conn, template: "workers-deploy", params: {}, rotationPolicy: "monthly" },
      templates,
    );
    expect(badPolicy.ok).toBe(false);
    if (!badPolicy.ok) expect(badPolicy.errors.rotationPolicy).toBeDefined();
  });
});
