/**
 * Unit tests for the catalog-portal dedicated-page view-model (CP5).
 *
 * Asserts the page is composed honestly from real catalog facts: documents are
 * built from the entity's own fields, the activity feed is provenance-only (no
 * fabricated deploy/incident metrics), and the dependency neighborhood resolves
 * through the shared graph context.
 */

import { buildContext } from "@web-console-next/lib/catalog-portal/model";
import { activityFor, buildPage, docsFor } from "@web-console-next/lib/catalog-portal/page";
import { service } from "./fixture";

/** A small graph: web depends on api; api is a resource-free component. */
function graph() {
  const web = service({
    entityRef: "component:default/web",
    owner: "growth",
    language: "TypeScript",
    system: "Growth",
    description: "The storefront.",
    lifecycle: "production",
    relations: [{ type: "dependsOn", targetRef: "component:default/api" }],
  });
  const api = service({
    entityRef: "component:default/api",
    owner: "payments",
    language: "Go",
    system: "Checkout",
    description: "The API.",
  });
  const ctx = buildContext([web, api]);
  return { web, api, ctx };
}

describe("docsFor", () => {
  it("always includes a README plus ARCHITECTURE and RUNBOOK for components", () => {
    const { web, ctx } = graph();
    const ids = docsFor(web, ctx).map((d) => d.id);
    expect(ids).toEqual(["readme", "arch", "runbook"]);
  });

  it("adds an API document for API-kind entities", () => {
    const api = service({ entityRef: "api:default/payments", system: "Checkout" });
    const ids = docsFor(api, buildContext([api])).map((d) => d.id);
    expect(ids).toContain("api");
  });

  it("uses PROVISIONING instead of arch/runbook for managed resources", () => {
    const res = service({ entityRef: "resource:default/db", system: "Checkout" });
    const ids = docsFor(res, buildContext([res])).map((d) => d.id);
    expect(ids).toEqual(["readme", "provision"]);
  });

  it("composes the README from real facts (description, deps, owner, language)", () => {
    const { web, ctx } = graph();
    const readme = docsFor(web, ctx)[0]!;
    const text = JSON.stringify(readme.blocks);
    expect(text).toContain("The storefront.");
    expect(text).toContain("api"); // resolved dependency name on the request path
    expect(text).toContain("TypeScript");
    expect(text).toContain("Growth");
    expect(readme.blocks[0]).toEqual({ type: "heading", level: 1, text: "web" });
  });
});

describe("activityFor (honest provenance only)", () => {
  it("always reports the snapshot reconciliation and nothing fabricated", () => {
    const { api } = graph();
    const events = activityFor(api);
    expect(events.map((e) => e.id)).toEqual(["reconciled"]);
    expect(events[0]!.title).toBe("Catalog snapshot reconciled");
  });

  it("adds a synced-from-commit event when the source commit is known", () => {
    const s = service({ entityRef: "component:default/api", sourceCommit: "sha256:deadbeefcafe" });
    const events = activityFor(s);
    expect(events.map((e) => e.id)).toContain("synced");
    expect(events.find((e) => e.id === "synced")!.meta).toBe("commit deadbeefc");
  });

  it("surfaces a deprecation event when the lifecycle is deprecated", () => {
    const s = service({ entityRef: "component:default/old", lifecycle: "deprecated" });
    expect(activityFor(s).map((e) => e.id)).toContain("deprecated");
  });
});

describe("buildPage", () => {
  it("computes the large readiness ring geometry", () => {
    const { web, ctx } = graph();
    const page = buildPage(web, ctx);
    expect(page.ringCircLg).toBe((2 * Math.PI * 32).toFixed(1));
    const offset = Number(page.ringOffsetLg);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThanOrEqual(Number(page.ringCircLg));
  });

  it("exposes the README as the overview blocks", () => {
    const { web, ctx } = graph();
    const page = buildPage(web, ctx);
    expect(page.overviewBlocks).toBe(page.docs[0]!.blocks);
  });

  it("resolves the dependency neighborhood through the context", () => {
    const { web, api, ctx } = graph();
    const webPage = buildPage(web, ctx);
    expect(webPage.dependsOnRefs).toHaveLength(1);
    expect(webPage.dependsOnRefs[0]).toMatchObject({ key: api.key, name: "api" });
    expect(webPage.usedByRefs).toHaveLength(0);

    const apiPage = buildPage(api, ctx);
    expect(apiPage.usedByRefs).toHaveLength(1);
    expect(apiPage.usedByRefs[0]).toMatchObject({ key: web.key, name: "web" });
  });

  it("degrades the ops strip honestly when no runtime signals exist", () => {
    const { web, ctx } = graph();
    expect(buildPage(web, ctx).hasOps).toBe(false);
  });
});
