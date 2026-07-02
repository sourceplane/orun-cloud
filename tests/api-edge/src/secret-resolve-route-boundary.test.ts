// SM3 route-boundary invariant: the lease-verified internal resolve
// (/v1/internal/config/secrets/resolve) — the ONLY decrypt path — must be
// UNREACHABLE through api-edge. api-edge never forwards /v1/internal/*, so no
// facade may claim it. The run-scoped resolve (…/state/runs/{id}/secrets/
// resolve) IS a public state route and must be forwarded.

import { isConfigRoute } from "@api-edge/config-facade";
import { isStateRoute } from "@api-edge/state-facade";

const INTERNAL_RESOLVE = "/v1/internal/config/secrets/resolve";
const RUN_RESOLVE = "/v1/organizations/org_abc/projects/prj_abc/state/runs/01JRUN/secrets/resolve";

describe("internal resolve is absent from every api-edge facade", () => {
  it("is not a config route", () => {
    expect(isConfigRoute(INTERNAL_RESOLVE)).toBe(false);
  });
  it("is not a state route", () => {
    expect(isStateRoute(INTERNAL_RESOLVE)).toBe(false);
  });
  it("no api-edge facade module even mentions the /v1/internal/ prefix as a route", () => {
    // /v1/internal/* is an internal service-binding namespace; the edge must
    // never route it. (Guards against a future facade widening that leak.)
    expect(isConfigRoute("/v1/internal/config/secrets/resolve")).toBe(false);
    expect(isConfigRoute("/v1/internal/anything")).toBe(false);
  });
});

describe("the run-scoped resolve IS a forwarded state route", () => {
  it("is a state route (state-worker owns the two-gate check)", () => {
    expect(isStateRoute(RUN_RESOLVE)).toBe(true);
  });
  it("is not a config route (it lives on the state plane)", () => {
    expect(isConfigRoute(RUN_RESOLVE)).toBe(false);
  });
});

describe("secret-policies routes ARE config routes (SM3 Layer-2 push/eval)", () => {
  it("org + project secret-policies (+ /evaluate) forward through the config facade", () => {
    expect(isConfigRoute("/v1/organizations/org_abc/config/secret-policies")).toBe(true);
    expect(isConfigRoute("/v1/organizations/org_abc/config/secret-policies/evaluate")).toBe(true);
    expect(isConfigRoute("/v1/organizations/org_abc/projects/prj_abc/config/secret-policies")).toBe(true);
  });
});
