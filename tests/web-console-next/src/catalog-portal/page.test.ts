/**
 * Unit tests for the catalog-portal dedicated-page view-model (CP5, revised by
 * saas-catalog-docs CD4).
 *
 * Asserts the page is composed honestly: the ONE derived surface (the badged
 * derived card) is built strictly from real catalog facts and never presented
 * as a file — the CP5 synthesized README/ARCHITECTURE/RUNBOOK/API documents
 * are gone (real docs are git-authored and fetched from the org doc index at
 * render). The activity feed stays provenance-only, and the dependency
 * neighborhood resolves through the shared graph context.
 */

import { buildContext } from "@web-console-next/lib/catalog-portal/model";
import { activityFor, buildPage, derivedBlocksFor } from "@web-console-next/lib/catalog-portal/page";
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

describe("derivedBlocksFor (the badged derived card — CD4 honesty rule)", () => {
  it("composes only real facts: description, deps, language, system, owner", () => {
    const { web, ctx } = graph();
    const text = JSON.stringify(derivedBlocksFor(web, ctx));
    expect(text).toContain("The storefront.");
    expect(text).toContain("api"); // resolved dependency name
    expect(text).toContain("TypeScript");
    expect(text).toContain("Growth");
    // Real CLI commands only — never invented endpoints/alerts/architecture.
    expect(text).toContain("orun catalog docs web --list");
  });

  it("never fabricates file framing or invented operational prose", () => {
    const { web, ctx } = graph();
    const text = JSON.stringify(derivedBlocksFor(web, ctx));
    expect(text).not.toContain("README");
    expect(text).not.toContain(".md");
    expect(text).not.toContain("Stateless replicas"); // genArch's invention
    expect(text).not.toContain("war room"); // genRunbook's invention
    expect(text).not.toContain("bearer token"); // genApi's invention
  });

  it("declares self-contained entities honestly", () => {
    const api = service({ entityRef: "component:default/api", system: "Checkout" });
    const text = JSON.stringify(derivedBlocksFor(api, buildContext([api])));
    expect(text).toContain("None declared");
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

  it("exposes the derived card blocks (the no-docs fallback body)", () => {
    const { web, ctx } = graph();
    const page = buildPage(web, ctx);
    expect(JSON.stringify(page.derivedBlocks)).toContain("The storefront.");
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
