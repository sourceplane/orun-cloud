import { workspaceIdCards } from "@web-console-next/components/settings/workspace-id-cards";

describe("workspaceIdCards (WID5 settings cards)", () => {
  it("leads with the durable ws_ id, then the legacy org_ id", () => {
    const cards = workspaceIdCards({ id: "org_abc", workspaceRef: "ws_3KF9TQ2P" });
    expect(cards.map((c) => c.kind)).toEqual(["durable", "legacy"]);
    expect(cards[0]).toMatchObject({ title: "Workspace ID", value: "ws_3KF9TQ2P" });
    expect(cards[1]).toMatchObject({ title: "Legacy Workspace ID", value: "org_abc" });
  });

  it("shows only the legacy card when workspaceRef is absent", () => {
    const cards = workspaceIdCards({ id: "org_abc" });
    expect(cards.map((c) => c.kind)).toEqual(["legacy"]);
    expect(cards[0]!.value).toBe("org_abc");
  });
});
