import { buildEntityNav, entityKeyFromPath } from "@web-console-next/components/shell/entity-nav";
import { encodeEntityKey } from "@web-console-next/lib/catalog-entity-key";

const KEY = encodeEntityKey({
  sourceProjectId: "prj_123",
  sourceEnvironment: "production",
  entityRef: "component:default/api",
});

describe("buildEntityNav", () => {
  it("derives the identity + tab links from the URL key alone", () => {
    const model = buildEntityNav("acme", KEY)!;
    expect(model.name).toBe("api");
    expect(model.kind).toBe("Component");
    expect(model.backHref).toBe("/orgs/acme/catalog");
    expect(model.links.map((l) => l.tab)).toEqual(["overview", "dependencies"]);
    expect(model.links.map((l) => l.label)).toEqual(["Overview", "Dependencies"]);
    // Overview is the query-less default; Dependencies carries `?tab=`.
    expect(model.links[0]!.href).toBe(`/orgs/acme/catalog/${KEY}`);
    expect(model.links[1]!.href).toBe(`/orgs/acme/catalog/${KEY}?tab=dependencies`);
  });

  it("returns null for a malformed key", () => {
    expect(buildEntityNav("acme", "not-a-real-key-$$$")).toBeNull();
  });
});

describe("entityKeyFromPath", () => {
  it("extracts the key from a catalog entity route", () => {
    expect(entityKeyFromPath("acme", `/orgs/acme/catalog/${KEY}`)).toBe(KEY);
  });

  it("ignores deeper tab segments, returning just the key", () => {
    expect(entityKeyFromPath("acme", `/orgs/acme/catalog/${KEY}/dependencies`)).toBe(KEY);
  });

  it("returns null on the catalog index itself", () => {
    expect(entityKeyFromPath("acme", "/orgs/acme/catalog")).toBeNull();
  });

  it("returns null off the catalog area or for another org", () => {
    expect(entityKeyFromPath("acme", "/orgs/acme/projects")).toBeNull();
    expect(entityKeyFromPath("acme", `/orgs/other/catalog/${KEY}`)).toBeNull();
    expect(entityKeyFromPath("acme", null)).toBeNull();
  });
});
