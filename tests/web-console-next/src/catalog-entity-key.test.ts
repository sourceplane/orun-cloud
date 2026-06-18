import {
  encodeEntityKey,
  decodeEntityKey,
  parseEntityRef,
  type EntityIdentity,
} from "@web-console-next/lib/catalog-entity-key";

describe("catalog entity key codec", () => {
  const cases: EntityIdentity[] = [
    { sourceProjectId: "prj_123", sourceEnvironment: "production", entityRef: "component:default/api" },
    { sourceProjectId: "prj_123", sourceEnvironment: null, entityRef: "api:default/payments" },
    { sourceProjectId: "prj_abc", sourceEnvironment: "staging", entityRef: "system:team-a/billing-system" },
  ];

  it("round-trips the identity triple", () => {
    for (const id of cases) {
      expect(decodeEntityKey(encodeEntityKey(id))).toEqual(id);
    }
  });

  it("preserves the null environment distinctly from empty", () => {
    const withNull = encodeEntityKey({ sourceProjectId: "prj_1", sourceEnvironment: null, entityRef: "component:default/x" });
    expect(decodeEntityKey(withNull)?.sourceEnvironment).toBeNull();
  });

  it("produces a URL-safe segment (no '/', '+', '=')", () => {
    for (const id of cases) {
      const key = encodeEntityKey(id);
      expect(key).not.toMatch(/[/+=]/);
    }
  });

  it("returns null for malformed input", () => {
    expect(decodeEntityKey("not-base64-$$$")).toBeNull();
    // Valid base64 but not the 3-part shape.
    expect(decodeEntityKey(encodeBare("only-one-part"))).toBeNull();
  });

  it("distinguishes entities that differ only by environment", () => {
    const ref = "component:default/api";
    const prod = encodeEntityKey({ sourceProjectId: "prj_1", sourceEnvironment: "prod", entityRef: ref });
    const stage = encodeEntityKey({ sourceProjectId: "prj_1", sourceEnvironment: "stage", entityRef: ref });
    expect(prod).not.toEqual(stage);
  });
});

describe("parseEntityRef", () => {
  it("splits kind / namespace / name", () => {
    expect(parseEntityRef("component:default/api")).toEqual({ kind: "Component", namespace: "default", name: "api" });
  });

  it("canonicalizes known kind casing (API stays upper)", () => {
    expect(parseEntityRef("api:default/payments").kind).toBe("API");
  });

  it("degrades gracefully on a ref without the expected shape", () => {
    expect(parseEntityRef("loose-name")).toEqual({ kind: "", namespace: null, name: "loose-name" });
  });
});

/** Helper: base64url of a raw string, for crafting a deliberately-malformed key. */
function encodeBare(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
