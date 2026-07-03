import {
  parseRotationPolicyDays,
  rotationStatus,
  chainBadges,
  secretHealthStats,
  revealGuard,
  MIN_REVEAL_REASON_LENGTH,
  policyTestRequest,
  syncStatusView,
  EMPTY_POLICY_TEST_FORM,
} from "@web-console-next/components/config/secrets-view";
import type { PublicSecretMetadata } from "@saas/contracts/config";

const NOW = new Date("2026-07-03T00:00:00Z");

function meta(overrides: Partial<PublicSecretMetadata>): PublicSecretMetadata {
  return {
    id: "sec_1",
    orgId: "org_1",
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: "stripe_key",
    displayName: null,
    status: "active",
    version: 1,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: "usr_1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("parseRotationPolicyDays", () => {
  it("parses day / week / hour units", () => {
    expect(parseRotationPolicyDays("90d")).toBe(90);
    expect(parseRotationPolicyDays("12w")).toBe(84);
    expect(parseRotationPolicyDays("720h")).toBe(30);
    expect(parseRotationPolicyDays(" 30d ")).toBe(30);
  });

  it("returns null for absent or malformed policies", () => {
    expect(parseRotationPolicyDays(null)).toBeNull();
    expect(parseRotationPolicyDays("")).toBeNull();
    expect(parseRotationPolicyDays("soon")).toBeNull();
    expect(parseRotationPolicyDays("0d")).toBeNull();
  });
});

describe("rotationStatus", () => {
  it("flags a secret overdue against its policy", () => {
    // last rotated 120d ago, policy 90d -> due.
    const r = rotationStatus(
      meta({ rotationPolicy: "90d", lastRotatedAt: "2026-03-05T00:00:00Z" }),
      NOW,
    );
    expect(r.due).toBe(true);
    expect(r.ageDays).toBe(120);
    expect(r.tone).toBe("warning");
    expect(r.label).toContain("Rotation due");
  });

  it("is not due when within the policy window", () => {
    const r = rotationStatus(
      meta({ rotationPolicy: "90d", lastRotatedAt: "2026-06-20T00:00:00Z" }),
      NOW,
    );
    expect(r.due).toBe(false);
    expect(r.tone).toBe("success");
    expect(r.label).toBe("13d / 90d");
  });

  it("falls back to createdAt when never rotated and has no policy", () => {
    const r = rotationStatus(meta({ createdAt: "2026-06-03T00:00:00Z" }), NOW);
    expect(r.due).toBe(false);
    expect(r.ageDays).toBe(30);
    expect(r.label).toBe("30d old");
  });

  it("tolerates malformed dates (age 0)", () => {
    const r = rotationStatus(meta({ createdAt: "not-a-date", lastRotatedAt: null }), NOW);
    expect(r.ageDays).toBe(0);
    expect(r.due).toBe(false);
  });
});

describe("chainBadges", () => {
  it("renders the serving rung", () => {
    const badges = chainBadges(meta({ servesFrom: "workspace" }));
    expect(badges.some((b) => b.label === "serves from workspace")).toBe(true);
  });

  it("marks a locked guardrail", () => {
    const badges = chainBadges(meta({ servesFrom: "account", overridable: false }));
    expect(badges.some((b) => b.label === "Locked" && b.tone === "warning")).toBe(true);
  });

  it("marks a personal overlay", () => {
    const badges = chainBadges(meta({ servesFrom: "personal", personal: true }));
    expect(badges.some((b) => b.label === "personal")).toBe(true);
  });

  it("emits nothing without provenance", () => {
    expect(chainBadges(meta({}))).toEqual([]);
  });
});

describe("secretHealthStats", () => {
  it("counts totals, rotation-due, locked, and personal overlays", () => {
    const stats = secretHealthStats(
      [
        // due: rotated 120d ago against a 90d policy.
        meta({ rotationPolicy: "90d", lastRotatedAt: "2026-03-05T00:00:00Z" }),
        // within window: not due.
        meta({ rotationPolicy: "90d", lastRotatedAt: "2026-06-20T00:00:00Z" }),
        // locked guardrail.
        meta({ overridable: false }),
        // personal overlay.
        meta({ personal: true }),
      ],
      NOW,
    );
    expect(stats).toEqual({ total: 4, rotationDue: 1, locked: 1, personal: 1 });
  });

  it("is all-zero (except total) for a policy-free, unlocked set", () => {
    const stats = secretHealthStats([meta({}), meta({})], NOW);
    expect(stats).toEqual({ total: 2, rotationDue: 0, locked: 0, personal: 0 });
  });

  it("handles an empty list", () => {
    expect(secretHealthStats([], NOW)).toEqual({
      total: 0,
      rotationDue: 0,
      locked: 0,
      personal: 0,
    });
  });
});

describe("revealGuard", () => {
  it("rejects an empty reason", () => {
    const r = revealGuard("   ");
    expect(r.ok).toBe(false);
  });

  it("rejects a too-short reason", () => {
    const r = revealGuard("oops");
    expect(r.ok).toBe(false);
  });

  it("accepts and trims a sufficient reason", () => {
    const r = revealGuard("  incident-1234 rotating leaked key  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("incident-1234 rotating leaked key");
  });

  it("uses the exported minimum length", () => {
    const exactly = "x".repeat(MIN_REVEAL_REASON_LENGTH);
    expect(revealGuard(exactly).ok).toBe(true);
    expect(revealGuard("x".repeat(MIN_REVEAL_REASON_LENGTH - 1)).ok).toBe(false);
  });
});

describe("policyTestRequest", () => {
  it("shapes a bare form into key/env/platform plus the chosen subject kind", () => {
    const req = policyTestRequest({
      ...EMPTY_POLICY_TEST_FORM,
      key: "STRIPE_KEY",
      env: "production",
      platform: "ci-oidc",
    });
    // The form's subject-kind select defaults to "user", so it always carries.
    expect(req).toEqual({
      key: "STRIPE_KEY",
      env: "production",
      platform: "ci-oidc",
      subject: { kind: "user" },
    });
  });

  it("includes only populated fact axes", () => {
    const req = policyTestRequest({
      ...EMPTY_POLICY_TEST_FORM,
      key: "STRIPE_KEY",
      env: "production",
      platform: "service",
      subjectId: "usr_1",
      subjectKind: "user",
      teams: "payments, sre ,",
      servesFrom: "workspace",
      componentType: "service",
      componentName: "checkout",
      triggerBranch: "main",
      triggerDeclared: true,
    });
    expect(req).toEqual({
      key: "STRIPE_KEY",
      env: "production",
      platform: "service",
      subject: { id: "usr_1", kind: "user", teams: ["payments", "sre"] },
      servesFrom: "workspace",
      component: { type: "service", name: "checkout" },
      trigger: { branch: "main", declared: true },
    });
  });

  it("defaults an unknown platform to local-cli", () => {
    const req = policyTestRequest({ ...EMPTY_POLICY_TEST_FORM, key: "K", env: "e", platform: "bogus" });
    expect(req.platform).toBe("local-cli");
  });
});

describe("syncStatusView", () => {
  it("maps each lifecycle status", () => {
    expect(syncStatusView({ status: "synced" })).toEqual({ label: "Synced", tone: "success" });
    expect(syncStatusView({ status: "superseded" })).toEqual({ label: "Superseded", tone: "secondary" });
    expect(syncStatusView({ status: "orphaned" })).toEqual({ label: "Orphaned", tone: "warning" });
  });

  it("passes an unknown status through as its label", () => {
    expect(syncStatusView({ status: "weird" })).toEqual({ label: "weird", tone: "secondary" });
  });
});
