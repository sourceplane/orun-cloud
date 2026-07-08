import {
  ROLE_CATALOG,
  CAPABILITY_AREAS,
  ROLE_MATRIX,
  roleLevel,
  ROLE_KEYS_MATCH_CONTRACT,
} from "@web-console-next/components/people/roles";
import { ORGANIZATION_ROLES } from "@saas/contracts/membership";

describe("ROLE_CATALOG", () => {
  it("covers every organization role and surfaces builder as Developer", () => {
    expect(ROLE_CATALOG.map((r) => r.key).sort()).toEqual([...ORGANIZATION_ROLES].sort());
    expect(ROLE_CATALOG.find((r) => r.key === "builder")!.label).toBe("Developer");
    expect(ROLE_KEYS_MATCH_CONTRACT).toBe(true);
  });
});

describe("ROLE_MATRIX", () => {
  it("has a level for every role × capability area", () => {
    for (const role of ROLE_CATALOG) {
      for (const area of CAPABILITY_AREAS) {
        expect(["full", "partial", "none"]).toContain(roleLevel(role.key, area.key));
      }
    }
  });

  it("encodes the headline semantics: owner is full everywhere; billing is owner+billing_admin only", () => {
    for (const area of CAPABILITY_AREAS) {
      expect(roleLevel("owner", area.key)).toBe("full");
    }
    expect(roleLevel("admin", "billing")).toBe("none");
    expect(roleLevel("billing_admin", "billing")).toBe("full");
    expect(roleLevel("viewer", "read")).toBe("full");
    expect(roleLevel("viewer", "projects")).toBe("none");
    expect(roleLevel("builder", "projects")).toBe("full");
    expect(roleLevel("builder", "members")).toBe("none");
  });

  it("defaults unknown role/area lookups to none", () => {
    expect(roleLevel("ghost", "read")).toBe("none");
    expect(roleLevel("owner", "teleport")).toBe("none");
  });

  it("keeps ROLE_MATRIX keys aligned with the catalog", () => {
    expect(Object.keys(ROLE_MATRIX).sort()).toEqual(ROLE_CATALOG.map((r) => r.key).sort());
  });
});
