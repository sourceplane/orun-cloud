import {
  connectionDisplayName,
  connectionStatusMeta,
  hasPendingConnection,
  reauthAffordance,
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

  // IH9 §5.3: a failed refresh / invalid parent token flips the connection to
  // suspended; the CTA re-runs the provider's connect flow (which reactivates
  // the existing row).
  describe("reauthAffordance (IH9 re-auth CTA)", () => {
    it("offers a provider-specific Reconnect for suspended oauth/token providers", () => {
      const supabase = reauthAffordance(connection({ provider: "supabase", status: "suspended" }));
      expect(supabase?.label).toBe("Reconnect");
      expect(supabase?.description).toBe(
        "The authorization expired or was revoked — reconnect to resume minting and brokered secrets.",
      );
      const cloudflare = reauthAffordance(
        connection({ provider: "cloudflare", status: "suspended" }),
      );
      expect(cloudflare?.label).toBe("Reconnect");
      expect(cloudflare?.description).toBe(
        "The parent token is invalid or expired — paste a fresh token to resume.",
      );
      const slack = reauthAffordance(connection({ provider: "slack", status: "suspended" }));
      expect(slack?.label).toBe("Reconnect");
      expect(slack?.description).toBe(
        "The workspace authorization was revoked — reconnect to resume delivery.",
      );
    });

    it("returns null for GitHub — its lifecycle is webhook-driven reinstall", () => {
      expect(reauthAffordance(connection({ provider: "github", status: "suspended" }))).toBeNull();
    });

    it("returns null for every non-suspended status", () => {
      for (const status of ["pending", "active", "revoked"] as const) {
        expect(reauthAffordance(connection({ provider: "supabase", status }))).toBeNull();
        expect(reauthAffordance(connection({ provider: "cloudflare", status }))).toBeNull();
        expect(reauthAffordance(connection({ provider: "slack", status }))).toBeNull();
      }
    });
  });
});
