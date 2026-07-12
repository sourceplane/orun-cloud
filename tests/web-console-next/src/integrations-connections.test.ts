import {
  connectionDisplayName,
  connectionStatusMeta,
  hasPendingConnection,
  uninstallDisclosure,
  visibleConnections,
} from "@web-console-next/components/integrations/connections";
import type { PublicConnection } from "@saas/contracts/integrations";

function connection(overrides?: Partial<PublicConnection>): PublicConnection {
  return {
    id: "int_1",
    orgId: "org_1",
    provider: "github",
    status: "active",
    scope: "account",
    shareMode: "auto",
    displayName: null,
    externalAccountLogin: "acme",
    externalAccountType: "Organization",
    repositorySelection: null,
    createdBy: "usr_1",
    connectedAt: "2026-06-11T10:00:00.000Z",
    revokedAt: null,
    suspendedAt: null,
    createdAt: "2026-06-11T09:59:00.000Z",
    updatedAt: "2026-06-11T10:00:00.000Z",
    ...overrides,
  };
}

describe("integrations connections view-model", () => {
  it("maps every status to a badge meta", () => {
    expect(connectionStatusMeta("active")).toEqual({ label: "Active", tone: "success" });
    expect(connectionStatusMeta("pending").tone).toBe("warning");
    expect(connectionStatusMeta("suspended").tone).toBe("warning");
    expect(connectionStatusMeta("revoked").tone).toBe("destructive");
  });

  it("prefers display name, then account login, then a provider-aware label", () => {
    expect(connectionDisplayName(connection({ displayName: "Prod GitHub" }))).toBe("Prod GitHub");
    expect(connectionDisplayName(connection())).toBe("acme");
    expect(
      connectionDisplayName(connection({ displayName: null, externalAccountLogin: null })),
    ).toBe("GitHub connection");
    expect(
      connectionDisplayName(
        connection({ provider: "slack", displayName: null, externalAccountLogin: null }),
      ),
    ).toBe("Slack connection");
  });

  it("discloses a provider-appropriate revoke blast radius", () => {
    expect(uninstallDisclosure(connection())).toContain("GitHub App");
    expect(uninstallDisclosure(connection({ provider: "slack" }))).toContain("bot token");
    expect(uninstallDisclosure(connection({ provider: "slack", scope: "workspace" }))).toContain(
      "Slack workspace",
    );
  });

  it("discloses the broker revoke blast radius: mints revoked, custody zeroized, secrets fail closed", () => {
    const cfAccount = uninstallDisclosure(connection({ provider: "cloudflare" }));
    expect(cfAccount).toContain("whole account");
    expect(cfAccount).toContain("child token");
    expect(cfAccount).toContain("zeroize");
    expect(cfAccount).toContain("fail closed");
    const cfWorkspace = uninstallDisclosure(connection({ provider: "cloudflare", scope: "workspace" }));
    expect(cfWorkspace).toContain("parent token");
    expect(cfWorkspace).toContain("fail closed");
    const sbAccount = uninstallDisclosure(connection({ provider: "supabase" }));
    expect(sbAccount).toContain("whole account");
    expect(sbAccount).toContain("refresh token");
    expect(sbAccount).toContain("fail closed");
    const sbWorkspace = uninstallDisclosure(connection({ provider: "supabase", scope: "workspace" }));
    expect(sbWorkspace).toContain("Supabase organization");
    expect(sbWorkspace).toContain("zeroize");
  });

  it("shows live rows plus only the most recent revoked row", () => {
    const rows = [
      connection({ id: "int_a", status: "active" }),
      connection({ id: "int_b", status: "revoked" }),
      connection({ id: "int_c", status: "revoked" }),
      connection({ id: "int_d", status: "pending" }),
    ];
    const visible = visibleConnections(rows);
    expect(visible.map((c) => c.id)).toEqual(["int_a", "int_d", "int_b"]);
  });

  it("detects in-flight pending connections for the popup poll loop", () => {
    expect(hasPendingConnection([connection({ status: "pending" })])).toBe(true);
    expect(hasPendingConnection([connection()])).toBe(false);
    expect(hasPendingConnection([])).toBe(false);
  });
});
