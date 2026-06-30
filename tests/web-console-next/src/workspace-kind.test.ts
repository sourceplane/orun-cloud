import { workspaceKindBadge } from "@web-console-next/components/shell/workspace-kind";

describe("workspaceKindBadge (WID5 switcher badge)", () => {
  it("labels an account root as Account (via kind)", () => {
    expect(workspaceKindBadge({ kind: "account", isAccountRoot: true })).toBe("Account");
  });

  it("labels a child as Workspace (via kind)", () => {
    expect(workspaceKindBadge({ kind: "workspace", isAccountRoot: false })).toBe("Workspace");
  });

  it("falls back to isAccountRoot when kind is absent", () => {
    expect(workspaceKindBadge({ isAccountRoot: true })).toBe("Account");
    expect(workspaceKindBadge({ isAccountRoot: false })).toBe("Workspace");
  });

  it("omits the badge when neither field is present (pre-WID4 payloads)", () => {
    expect(workspaceKindBadge({})).toBeNull();
  });
});
