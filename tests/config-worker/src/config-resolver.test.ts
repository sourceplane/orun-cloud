import { resolveSetting, findLockedAccountSetting, resolveEffectiveSecret, findLockedSecretAbove } from "@config-worker/config-resolver";
import type { ConfigRepository, ResolveScope, Scope, SecretMetadata, Setting } from "@saas/db/config";
import type { MembershipRepository, Organization } from "@saas/db/membership";

const NOW = new Date("2026-06-30T00:00:00Z");

// org/account uuids
const WORKSPACE_ORG = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_ORG = "99999999-9999-9999-9999-999999999999";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const ENVIRONMENT = "44444444-4444-4444-4444-444444444444";

const ORG_SCOPE: Scope = { kind: "organization", orgId: WORKSPACE_ORG };
const PRJ_SCOPE: Scope = { kind: "project", orgId: WORKSPACE_ORG, projectId: PROJECT };
const ENV_SCOPE: Scope = { kind: "environment", orgId: WORKSPACE_ORG, projectId: PROJECT, environmentId: ENVIRONMENT };

function setting(scopeKind: Setting["scopeKind"], value: unknown, overridable = true): Setting {
  return {
    id: `set-${scopeKind}`,
    orgId: scopeKind === "account" ? ACCOUNT_ORG : WORKSPACE_ORG,
    projectId: scopeKind === "project" || scopeKind === "environment" ? PROJECT : null,
    environmentId: scopeKind === "environment" ? ENVIRONMENT : null,
    scopeKind,
    key: "theme",
    value,
    description: null,
    overridable,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * Fake config repo whose `getSettingByScopeKey` returns a pre-seeded row per scope
 * kind, modeling "different rows per scope".
 */
function fakeRepo(rowsByKind: Partial<Record<Setting["scopeKind"], Setting>>): Pick<ConfigRepository, "getSettingByScopeKey"> {
  return {
    getSettingByScopeKey(scope: ResolveScope, _key: string) {
      const row = rowsByKind[scope.kind];
      if (row) {
        return Promise.resolve({ ok: true as const, value: row });
      }
      return Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } });
    },
  };
}

function fakeMembership(opts?: { fail?: boolean; parentOrgId?: string | null }): Pick<MembershipRepository, "getOrganizationById"> {
  return {
    getOrganizationById(id: string) {
      if (opts?.fail) {
        return Promise.resolve({ ok: false as const, error: { kind: "internal" as const, message: "boom" } });
      }
      const org: Organization = {
        id,
        name: "Acme",
        slug: "acme",
        slugLower: "acme",
        publicRef: "ws_TESTTEST",
        status: "active",
        parentOrgId: opts?.parentOrgId === undefined ? ACCOUNT_ORG : opts.parentOrgId,
        createdAt: NOW,
        updatedAt: NOW,
      };
      return Promise.resolve({ ok: true as const, value: org });
    },
  };
}

describe("resolveSetting — precedence", () => {
  it("environment wins over project, workspace, and account", async () => {
    const repo = fakeRepo({
      environment: setting("environment", "env-val"),
      project: setting("project", "prj-val"),
      organization: setting("organization", "org-val"),
      account: setting("account", "acct-val"),
    });
    const resolved = await resolveSetting(repo, fakeMembership(), ENV_SCOPE, "theme");
    expect(resolved.value).toBe("env-val");
    expect(resolved.source).toBe("environment");
  });

  it("project wins over workspace and account (project scope)", async () => {
    const repo = fakeRepo({
      project: setting("project", "prj-val"),
      organization: setting("organization", "org-val"),
      account: setting("account", "acct-val"),
    });
    const resolved = await resolveSetting(repo, fakeMembership(), PRJ_SCOPE, "theme");
    expect(resolved.value).toBe("prj-val");
    expect(resolved.source).toBe("project");
  });

  it("workspace(org) wins over account", async () => {
    const repo = fakeRepo({
      organization: setting("organization", "org-val"),
      account: setting("account", "acct-val"),
    });
    const resolved = await resolveSetting(repo, fakeMembership(), ORG_SCOPE, "theme");
    expect(resolved.value).toBe("org-val");
    expect(resolved.source).toBe("organization");
  });

  it("account value is inherited when no more-specific value exists", async () => {
    const repo = fakeRepo({ account: setting("account", "acct-val", false) });
    const resolved = await resolveSetting(repo, fakeMembership(), ENV_SCOPE, "theme");
    expect(resolved.value).toBe("acct-val");
    expect(resolved.source).toBe("account");
    expect(resolved.overridable).toBe(false);
  });

  it("falls back to default when nothing is found in the chain", async () => {
    const repo = fakeRepo({});
    const resolved = await resolveSetting(repo, fakeMembership(), ORG_SCOPE, "theme");
    expect(resolved.value).toBeUndefined();
    expect(resolved.source).toBe("default");
    expect(resolved.setting).toBeNull();
  });

  it("fail-soft: skips the account rung when the org fetch fails", async () => {
    const repo = fakeRepo({ account: setting("account", "acct-val") });
    const resolved = await resolveSetting(repo, fakeMembership({ fail: true }), ORG_SCOPE, "theme");
    // account rung not probed → falls through to default
    expect(resolved.source).toBe("default");
  });

  it("resolves the account uuid via effectiveBillingOrgId (parent) for the account rung", async () => {
    const probed: ResolveScope[] = [];
    const repo: Pick<ConfigRepository, "getSettingByScopeKey"> = {
      getSettingByScopeKey(scope) {
        probed.push(scope);
        return Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } });
      },
    };
    await resolveSetting(repo, fakeMembership({ parentOrgId: ACCOUNT_ORG }), ORG_SCOPE, "theme");
    const accountRung = probed.find((s) => s.kind === "account");
    expect(accountRung).toEqual({ kind: "account", accountId: ACCOUNT_ORG });
  });

  it("a standalone org (no parent) resolves its account rung to its own id", async () => {
    const probed: ResolveScope[] = [];
    const repo: Pick<ConfigRepository, "getSettingByScopeKey"> = {
      getSettingByScopeKey(scope) {
        probed.push(scope);
        return Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } });
      },
    };
    await resolveSetting(repo, fakeMembership({ parentOrgId: null }), ORG_SCOPE, "theme");
    const accountRung = probed.find((s) => s.kind === "account");
    expect(accountRung).toEqual({ kind: "account", accountId: WORKSPACE_ORG });
  });
});

describe("findLockedAccountSetting — write guardrail", () => {
  it("returns the locked account setting when the account value is overridable=false", async () => {
    const repo = fakeRepo({ account: setting("account", "acct-val", false) });
    const locked = await findLockedAccountSetting(repo, fakeMembership(), ORG_SCOPE, "theme");
    expect(locked).not.toBeNull();
    expect(locked!.overridable).toBe(false);
  });

  it("returns null when the account value is overridable=true", async () => {
    const repo = fakeRepo({ account: setting("account", "acct-val", true) });
    const locked = await findLockedAccountSetting(repo, fakeMembership(), ORG_SCOPE, "theme");
    expect(locked).toBeNull();
  });

  it("returns null when there is no account value", async () => {
    const repo = fakeRepo({});
    const locked = await findLockedAccountSetting(repo, fakeMembership(), ORG_SCOPE, "theme");
    expect(locked).toBeNull();
  });

  it("returns null (fail-soft) when the org fetch fails", async () => {
    const repo = fakeRepo({ account: setting("account", "acct-val", false) });
    const locked = await findLockedAccountSetting(repo, fakeMembership({ fail: true }), ORG_SCOPE, "theme");
    expect(locked).toBeNull();
  });
});

// ── Secrets chain (saas-secret-manager SM1) ─────────────────

const VIEWER = "abababab-abab-abab-abab-abababababab";
const OTHER_VIEWER = "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd";

function secret(
  scopeKind: SecretMetadata["scopeKind"],
  overrides?: Partial<SecretMetadata>,
): SecretMetadata {
  return {
    id: `sec-${scopeKind}`,
    orgId: scopeKind === "account" ? ACCOUNT_ORG : WORKSPACE_ORG,
    projectId: scopeKind === "project" || scopeKind === "environment" ? PROJECT : null,
    environmentId: scopeKind === "environment" ? ENVIRONMENT : null,
    scopeKind,
    secretKey: "DB_PASSWORD",
    displayName: null,
    status: "active",
    version: 1,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: VIEWER,
    personalOwner: null,
    source: "static" as const,
    bindingProvider: null,
    bindingConnectionId: null,
    bindingTemplate: null,
    rotationProvider: null,
    rotationConnectionId: null,
    rotationTemplate: null,
    rotationParams: null,
    rotationGraceSeconds: null,
    rotationDeliverTarget: null,
    overridable: true,
    lastUsedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Fake config repo whose `getSecretMetadataByScopeKey` returns a pre-seeded row
 * per scope kind; personal-rung probes (personalOwner given) only hit when the
 * seeded row's owner matches.
 */
function fakeSecretRepo(
  rowsByKind: Partial<Record<SecretMetadata["scopeKind"], SecretMetadata>>,
): Pick<ConfigRepository, "getSecretMetadataByScopeKey"> {
  return {
    getSecretMetadataByScopeKey(scope: ResolveScope, _key: string, personalOwner?: string) {
      const row = rowsByKind[scope.kind];
      const matches = row && (personalOwner === undefined
        ? row.personalOwner === null
        : row.personalOwner === personalOwner);
      if (matches) {
        return Promise.resolve({ ok: true as const, value: row });
      }
      return Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } });
    },
  };
}

describe("resolveEffectiveSecret — precedence", () => {
  const ENV_QUERY = { orgId: WORKSPACE_ORG, projectId: PROJECT, environmentId: ENVIRONMENT, key: "DB_PASSWORD" };

  it("environment beats project, workspace, and account", async () => {
    const repo = fakeSecretRepo({
      environment: secret("environment"),
      project: secret("project"),
      organization: secret("organization"),
      account: secret("account"),
    });
    const resolved = await resolveEffectiveSecret({ repo, membershipRepo: fakeMembership() }, ENV_QUERY);
    expect(resolved.secret?.scopeKind).toBe("environment");
    expect(resolved.servesFrom).toBe("environment");
  });

  it("project beats workspace and account", async () => {
    const repo = fakeSecretRepo({
      project: secret("project"),
      organization: secret("organization"),
      account: secret("account"),
    });
    const resolved = await resolveEffectiveSecret({ repo, membershipRepo: fakeMembership() }, ENV_QUERY);
    expect(resolved.servesFrom).toBe("project");
  });

  it("workspace(org) beats account and reads as servesFrom=workspace", async () => {
    const repo = fakeSecretRepo({
      organization: secret("organization"),
      account: secret("account"),
    });
    const resolved = await resolveEffectiveSecret({ repo, membershipRepo: fakeMembership() }, ENV_QUERY);
    expect(resolved.secret?.scopeKind).toBe("organization");
    expect(resolved.servesFrom).toBe("workspace");
  });

  it("account serves when no more-specific head exists", async () => {
    const repo = fakeSecretRepo({ account: secret("account", { overridable: false }) });
    const resolved = await resolveEffectiveSecret({ repo, membershipRepo: fakeMembership() }, ENV_QUERY);
    expect(resolved.servesFrom).toBe("account");
    expect(resolved.overridable).toBe(false);
  });

  it("personal beats environment for the owner", async () => {
    const repo = fakeSecretRepo({
      environment: secret("environment", { personalOwner: VIEWER }),
    });
    const resolved = await resolveEffectiveSecret(
      { repo, membershipRepo: fakeMembership() },
      { ...ENV_QUERY, viewerSubjectId: VIEWER },
    );
    expect(resolved.servesFrom).toBe("personal");
    expect(resolved.secret?.personalOwner).toBe(VIEWER);
  });

  it("someone else's personal overlay never serves another viewer", async () => {
    const repo = fakeSecretRepo({
      environment: secret("environment", { personalOwner: VIEWER }),
      organization: secret("organization"),
    });
    const resolved = await resolveEffectiveSecret(
      { repo, membershipRepo: fakeMembership() },
      { ...ENV_QUERY, viewerSubjectId: OTHER_VIEWER },
    );
    expect(resolved.servesFrom).toBe("workspace");
  });

  it("no personal rung without a viewer", async () => {
    const repo = fakeSecretRepo({ organization: secret("organization") });
    const resolved = await resolveEffectiveSecret({ repo, membershipRepo: fakeMembership() }, ENV_QUERY);
    expect(resolved.servesFrom).toBe("workspace");
  });

  it("returns null when no rung has the key", async () => {
    const resolved = await resolveEffectiveSecret(
      { repo: fakeSecretRepo({}), membershipRepo: fakeMembership() },
      ENV_QUERY,
    );
    expect(resolved.secret).toBeNull();
    expect(resolved.servesFrom).toBeNull();
    expect(resolved.overridable).toBe(true);
  });

  it("fail-soft: skips the account rung when the org fetch fails", async () => {
    const repo = fakeSecretRepo({ account: secret("account") });
    const resolved = await resolveEffectiveSecret(
      { repo, membershipRepo: fakeMembership({ fail: true }) },
      ENV_QUERY,
    );
    expect(resolved.secret).toBeNull();
  });
});

describe("findLockedSecretAbove — write guardrail", () => {
  it("hits a locked organization-scope key above a project write", async () => {
    const repo = fakeSecretRepo({ organization: secret("organization", { overridable: false }) });
    const locked = await findLockedSecretAbove(repo, fakeMembership(), PRJ_SCOPE, "DB_PASSWORD");
    expect(locked).not.toBeNull();
    expect(locked!.scopeKind).toBe("organization");
  });

  it("hits a locked account-scope key above an environment write", async () => {
    const repo = fakeSecretRepo({ account: secret("account", { overridable: false }) });
    const locked = await findLockedSecretAbove(repo, fakeMembership(), ENV_SCOPE, "DB_PASSWORD");
    expect(locked).not.toBeNull();
    expect(locked!.scopeKind).toBe("account");
  });

  it("an organization write only probes the account rung (never itself)", async () => {
    const repo = fakeSecretRepo({
      organization: secret("organization", { overridable: false }),
      account: secret("account", { overridable: false }),
    });
    const locked = await findLockedSecretAbove(repo, fakeMembership(), ORG_SCOPE, "DB_PASSWORD");
    expect(locked!.scopeKind).toBe("account");
  });

  it("returns null when the rows above are overridable", async () => {
    const repo = fakeSecretRepo({
      organization: secret("organization"),
      account: secret("account"),
    });
    const locked = await findLockedSecretAbove(repo, fakeMembership(), PRJ_SCOPE, "DB_PASSWORD");
    expect(locked).toBeNull();
  });

  it("returns null (fail-soft) for the account rung when the org fetch fails", async () => {
    const repo = fakeSecretRepo({ account: secret("account", { overridable: false }) });
    const locked = await findLockedSecretAbove(repo, fakeMembership({ fail: true }), PRJ_SCOPE, "DB_PASSWORD");
    expect(locked).toBeNull();
  });
});
