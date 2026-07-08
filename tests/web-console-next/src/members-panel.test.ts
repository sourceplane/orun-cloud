import {
  MEMBER_ROLE_OPTIONS,
  primaryRole,
  isRoleChange,
} from "@web-console-next/components/people/members";

describe("primaryRole", () => {
  it("prefers owner so the most-privileged grant is shown/edited", () => {
    expect(primaryRole([{ role: "viewer" }, { role: "owner" }])).toBe("owner");
  });

  it("falls back to the first role, then viewer for a member with no role fact", () => {
    expect(primaryRole([{ role: "admin" }])).toBe("admin");
    expect(primaryRole([])).toBe("viewer");
  });
});

describe("isRoleChange", () => {
  it("is true only for a different, known role", () => {
    expect(isRoleChange("viewer", "admin")).toBe(true);
    expect(isRoleChange("admin", "admin")).toBe(false);
    expect(isRoleChange("admin", "not_a_role")).toBe(false);
  });
});

describe("MEMBER_ROLE_OPTIONS", () => {
  it("offers the organization roles", () => {
    expect(MEMBER_ROLE_OPTIONS).toContain("owner");
    expect(MEMBER_ROLE_OPTIONS).toContain("viewer");
    expect(MEMBER_ROLE_OPTIONS).toContain("billing_admin");
  });
});
