import { handleResolveOrgRef } from "@membership-worker/handlers/resolve-org-ref";
import type { Env } from "@membership-worker/env";
import type { Organization, MembershipResult } from "@saas/db/membership";

const env = { ENVIRONMENT: "test" } as Env;
const ORG_HEX = "2f65ddde-1f5b-4e93-8c0b-80e030e31229";
const ORG_PUB = "org_2f65ddde1f5b4e938c0b80e030e31229";
const WS_REF = "ws_3KF9TQ2P";

function org(over?: Partial<Organization>): Organization {
  return {
    id: ORG_HEX,
    name: "Acme",
    slug: "acme",
    slugLower: "acme",
    publicRef: WS_REF,
    status: "active",
    parentOrgId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function req(body: unknown): Request {
  return new Request("https://m/v1/internal/membership/resolve-org-ref", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Repo = {
  getOrganizationById?: (id: string) => Promise<MembershipResult<Organization>>;
  getOrganizationBySlug?: (slug: string) => Promise<MembershipResult<Organization>>;
  getOrganizationByPublicRef?: (ref: string) => Promise<MembershipResult<Organization>>;
};

function depsWith(repo: Repo, calls?: { byId?: string[]; bySlug?: string[]; byRef?: string[] }) {
  return {
    repo: {
      getOrganizationById: async (id: string) => {
        calls?.byId?.push(id);
        return repo.getOrganizationById
          ? repo.getOrganizationById(id)
          : ({ ok: false, error: { kind: "not_found" } } as MembershipResult<Organization>);
      },
      getOrganizationBySlug: async (slug: string) => {
        calls?.bySlug?.push(slug);
        return repo.getOrganizationBySlug
          ? repo.getOrganizationBySlug(slug)
          : ({ ok: false, error: { kind: "not_found" } } as MembershipResult<Organization>);
      },
      getOrganizationByPublicRef: async (ref: string) => {
        calls?.byRef?.push(ref);
        return repo.getOrganizationByPublicRef
          ? repo.getOrganizationByPublicRef(ref)
          : ({ ok: false, error: { kind: "not_found" } } as MembershipResult<Organization>);
      },
    },
  };
}

describe("handleResolveOrgRef (WID3)", () => {
  it("resolves an org_<hex> ref via getOrganizationById and echoes the canonical id", async () => {
    const calls = { byId: [] as string[], bySlug: [] as string[], byRef: [] as string[] };
    const res = await handleResolveOrgRef(
      req({ ref: ORG_PUB }),
      env,
      "req",
      depsWith({ getOrganizationById: async () => ({ ok: true, value: org() }) }, calls),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { orgId: string; slug: string; publicRef: string } };
    expect(body.data.orgId).toBe(ORG_PUB);
    expect(body.data.slug).toBe("acme");
    expect(body.data.publicRef).toBe(WS_REF);
    expect(calls.byId).toEqual([ORG_HEX]);
    expect(calls.bySlug).toEqual([]);
    expect(calls.byRef).toEqual([]);
  });

  it("resolves a ws_ ref via getOrganizationByPublicRef", async () => {
    const calls = { byId: [] as string[], bySlug: [] as string[], byRef: [] as string[] };
    const res = await handleResolveOrgRef(
      req({ ref: WS_REF }),
      env,
      "req",
      depsWith({ getOrganizationByPublicRef: async () => ({ ok: true, value: org() }) }, calls),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { orgId: string } };
    expect(body.data.orgId).toBe(ORG_PUB);
    expect(calls.byRef).toEqual([WS_REF]);
    expect(calls.byId).toEqual([]);
  });

  it("resolves a slug ref via getOrganizationBySlug (lower-cased)", async () => {
    const calls = { byId: [] as string[], bySlug: [] as string[], byRef: [] as string[] };
    const res = await handleResolveOrgRef(
      req({ ref: "Acme" }),
      env,
      "req",
      depsWith({ getOrganizationBySlug: async () => ({ ok: true, value: org() }) }, calls),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { orgId: string } };
    expect(body.data.orgId).toBe(ORG_PUB);
    expect(calls.bySlug).toEqual(["acme"]);
  });

  it("404 when the ref names no org", async () => {
    const res = await handleResolveOrgRef(
      req({ ref: "nope" }),
      env,
      "req",
      depsWith({ getOrganizationBySlug: async () => ({ ok: false, error: { kind: "not_found" } }) }),
    );
    expect(res.status).toBe(404);
  });

  it("404 when an org_ ref decodes but the row is absent", async () => {
    const res = await handleResolveOrgRef(
      req({ ref: ORG_PUB }),
      env,
      "req",
      depsWith({ getOrganizationById: async () => ({ ok: false, error: { kind: "not_found" } }) }),
    );
    expect(res.status).toBe(404);
  });

  it("400 on a malformed org_ ref", async () => {
    const res = await handleResolveOrgRef(req({ ref: "org_not-hex" }), env, "req", depsWith({}));
    expect(res.status).toBe(400);
  });

  it("400 when ref is missing", async () => {
    const res = await handleResolveOrgRef(req({}), env, "req", depsWith({}));
    expect(res.status).toBe(400);
  });

  it("405 on a non-POST request", async () => {
    const getReq = new Request("https://m/v1/internal/membership/resolve-org-ref", { method: "GET" });
    const res = await handleResolveOrgRef(getReq, env, "req", depsWith({}));
    expect(res.status).toBe(405);
  });
});
