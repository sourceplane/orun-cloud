import { handleResolveSetting } from "@config-worker/handlers/resolve-setting";
import type { Env } from "@config-worker/env";
import type { ActorContext } from "@config-worker/router";
import type { ConfigRepository, ResolveScope, Scope, Setting } from "@saas/db/config";
import type { MembershipRepository, Organization } from "@saas/db/membership";

const NOW = new Date("2026-06-30T00:00:00Z");
const WORKSPACE_ORG = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_ORG = "99999999-9999-9999-9999-999999999999";

const ACTOR: ActorContext = { subjectId: "usr_aabbccdd", subjectType: "user" };
const ORG_SCOPE: Scope = { kind: "organization", orgId: WORKSPACE_ORG };
const FAKE_ENV = {} as Env;

type JsonResp = {
  data: { setting?: { value: unknown; scopeKind: string; overridable?: boolean; inheritedFrom?: { scopeKind: string } | null; key: string } };
  error: { code: string; message?: string };
};

function makeReq(key: string | null): Request {
  const url = key === null
    ? "https://config-worker/v1/organizations/x/config/settings/resolve"
    : `https://config-worker/v1/organizations/x/config/settings/resolve?key=${encodeURIComponent(key)}`;
  return new Request(url, { method: "GET" });
}

function accountSetting(value: unknown, overridable: boolean): Setting {
  return {
    id: "set-acct",
    orgId: ACCOUNT_ORG,
    projectId: null,
    environmentId: null,
    scopeKind: "account",
    key: "theme",
    value,
    description: null,
    overridable,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fakeRepo(account: Setting | null): Pick<ConfigRepository, "getSettingByScopeKey"> {
  return {
    getSettingByScopeKey(scope: ResolveScope) {
      if (scope.kind === "account" && account) {
        return Promise.resolve({ ok: true as const, value: account });
      }
      return Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } });
    },
  };
}

const membershipParent: Pick<MembershipRepository, "getOrganizationById"> = {
  getOrganizationById: (id) => {
    const org: Organization = {
      id, name: "Acme", slug: "acme", slugLower: "acme", publicRef: "ws_X",
      status: "active", parentOrgId: ACCOUNT_ORG, createdAt: NOW, updatedAt: NOW,
    };
    return Promise.resolve({ ok: true as const, value: org });
  },
};

describe("handleResolveSetting", () => {
  it("returns 422 when no key query param is supplied", async () => {
    const res = await handleResolveSetting(makeReq(null), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: fakeRepo(null),
      membershipRepo: membershipParent,
    });
    expect(res.status).toBe(422);
  });

  it("resolves an inherited account value with provenance", async () => {
    const res = await handleResolveSetting(makeReq("theme"), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: fakeRepo(accountSetting({ dark: true }, true)),
      membershipRepo: membershipParent,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonResp;
    expect(body.data.setting!.value).toEqual({ dark: true });
    expect(body.data.setting!.inheritedFrom).toEqual({ scopeKind: "account" });
    expect(body.data.setting!.overridable).toBe(true);
  });

  it("surfaces overridable=false for a locked inherited account guardrail", async () => {
    const res = await handleResolveSetting(makeReq("theme"), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: fakeRepo(accountSetting("locked", false)),
      membershipRepo: membershipParent,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonResp;
    expect(body.data.setting!.overridable).toBe(false);
    expect(body.data.setting!.inheritedFrom).toEqual({ scopeKind: "account" });
  });

  it("returns a default-source setting when nothing is found", async () => {
    const res = await handleResolveSetting(makeReq("theme"), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: fakeRepo(null),
      membershipRepo: membershipParent,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonResp;
    expect(body.data.setting!.scopeKind).toBe("default");
    expect(body.data.setting!.inheritedFrom).toEqual({ scopeKind: "default" });
    expect(body.data.setting!.value).toBeUndefined();
  });
});
