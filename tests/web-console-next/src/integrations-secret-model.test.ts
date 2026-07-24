// saas-integrations-console IX3: the infrastructure detail's secret view-model —
// which secrets a connection produces (brokered/rotated), the meta line, and the
// status badge. Derived by filtering the org secrets list on the binding/rotation
// connection id.

import type { PublicSecretMetadata } from "@saas/contracts/config";
import type { PublicConnectionCustody } from "@saas/contracts/integrations";
import {
  connectionSecrets,
  producerCounts,
  rotationDays,
  secretBadge,
  secretMetaLine,
  secretProducer,
} from "@web-console-next/components/integrations/secret-model";
import { custodyProjectRefs } from "@web-console-next/components/integrations/detail-model";

function secret(overrides: Partial<PublicSecretMetadata>): PublicSecretMetadata {
  return {
    id: "sec_1",
    orgId: "org_1",
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: "SUPABASE_DB_URL",
    displayName: null,
    status: "active",
    version: 1,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: "usr_1",
    ...overrides,
  } as PublicSecretMetadata;
}

const brokered = (cid: string, template = "db-ro") =>
  secret({ source: "brokered", binding: { provider: "supabase", connectionId: cid, template } });

const rotated = (cid: string, policy: string | null = "P90D") =>
  secret({
    source: "static",
    secretKey: "SUPABASE_SERVICE_ROLE_KEY",
    rotationPolicy: policy,
    rotation: { provider: "supabase", connectionId: cid, template: "service", graceSeconds: null, deliverTarget: null },
  } as Partial<PublicSecretMetadata>);

describe("secretProducer", () => {
  it("classifies brokered, rotated, and neither", () => {
    expect(secretProducer(brokered("int_1"))).toEqual({ mode: "brokered", provider: "supabase", template: "db-ro" });
    expect(secretProducer(rotated("int_1"))).toEqual({ mode: "rotated", provider: "supabase", template: "service" });
    expect(secretProducer(secret({ source: "static" }))).toBeNull();
  });
});

describe("connectionSecrets", () => {
  it("returns only the brokered + rotated secrets bound to the connection", () => {
    const all = [
      brokered("int_1", "db-ro"),
      brokered("int_1", "storage"),
      rotated("int_1"),
      brokered("int_2", "workers"), // other connection
      secret({ source: "static" }), // plain static
    ];
    const produced = connectionSecrets(all, "int_1");
    expect(produced.map((p) => p.template)).toEqual(["db-ro", "storage", "service"]);
    expect(produced.map((p) => p.mode)).toEqual(["brokered", "brokered", "rotated"]);
    expect(connectionSecrets(all, "int_missing")).toEqual([]);
    expect(connectionSecrets(null, "int_1")).toEqual([]);
  });
});

describe("meta line + badge + counts", () => {
  it("secretMetaLine", () => {
    expect(secretMetaLine(connectionSecrets([brokered("int_1", "db-ro")], "int_1")[0]!)).toBe(
      "brokered · supabase · db-ro",
    );
  });

  it("rotationDays parses several policy forms", () => {
    expect(rotationDays("P90D")).toBe(90);
    expect(rotationDays("90d")).toBe(90);
    expect(rotationDays("30")).toBe(30);
    expect(rotationDays(null)).toBeNull();
    expect(rotationDays("weekly")).toBeNull();
  });

  it("secretBadge — brokered fresh, rotated cadence, orphaned wins", () => {
    const b = connectionSecrets([brokered("int_1")], "int_1")[0]!;
    const r = connectionSecrets([rotated("int_1", "P90D")], "int_1")[0]!;
    expect(secretBadge(b)).toEqual({ label: "Fresh per run", tone: "success" });
    expect(secretBadge(r)).toEqual({ label: "Rotated · 90d", tone: "info" });
    const orphan = connectionSecrets([brokered("int_1")], "int_1")[0]!;
    orphan.secret.orphaned = true;
    expect(secretBadge(orphan)).toEqual({ label: "Orphaned", tone: "error" });
  });

  it("producerCounts tallies brokered vs rotated", () => {
    const produced = connectionSecrets([brokered("int_1"), brokered("int_1", "storage"), rotated("int_1")], "int_1");
    expect(producerCounts(produced)).toEqual({ total: 3, brokered: 2, rotated: 1 });
  });
});

describe("custodyProjectRefs", () => {
  function custody(overrides: Partial<PublicConnectionCustody>): PublicConnectionCustody {
    return {
      kind: "supabase_project_secret",
      credentialClass: "infrastructure",
      userDerived: false,
      rotatedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      scopes: null,
      ...overrides,
    } as PublicConnectionCustody;
  }

  it("extracts string scope refs, skipping non-strings and non-array scopes", () => {
    const rows = [
      custody({ kind: "supabase_project_secret", scopes: ["acme-prod-primary", "acme-prod-analytics"] }),
      custody({ kind: "supabase_refresh_token", scopes: null }),
      custody({ kind: "x", scopes: [1, "keep", null] as unknown[] }),
    ];
    expect(custodyProjectRefs(rows).map((p) => p.ref)).toEqual([
      "acme-prod-primary",
      "acme-prod-analytics",
      "keep",
    ]);
    expect(custodyProjectRefs(null)).toEqual([]);
  });
});
