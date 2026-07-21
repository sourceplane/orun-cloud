// CX6 hardening (saas-copilot-surface): the dialect pin — every event type
// the platform emits exists in the UPSTREAM @ag-ui vocabulary, so protocol
// drift fails this build loudly instead of silently breaking the engine —
// and the kill switch's brain (flag default OFF, explicit opt-in only).

import { EventType } from "@ag-ui/core";
import { AGUI_EVENT_TYPES, AGUI_DIALECT_VERSION, CLIENT_TOOLS_V1 } from "@saas/contracts/agui";
import { parseCopilotFlag } from "@web-console-next/components/copilot/flag";

describe("CX6: the dialect pin", () => {
  it("every emitted event type is a stock @ag-ui EventType", () => {
    const stock = new Set(Object.values(EventType) as string[]);
    for (const t of AGUI_EVENT_TYPES) {
      expect(stock.has(t)).toBe(true);
    }
  });

  it("the dialect version is pinned (a bump is a deliberate adapter change)", () => {
    expect(AGUI_DIALECT_VERSION).toBe(1);
  });

  it("the client-tool registry stays closed at six ui_ verbs", () => {
    expect(CLIENT_TOOLS_V1).toHaveLength(6);
    for (const t of CLIENT_TOOLS_V1) expect(t.name.startsWith("ui_")).toBe(true);
  });
});

describe("CX6: the kill switch", () => {
  it("defaults OFF — only an explicit opt-in enables the copilot surfaces", () => {
    expect(parseCopilotFlag(undefined)).toBe(false);
    expect(parseCopilotFlag("")).toBe(false);
    expect(parseCopilotFlag("off")).toBe(false);
    expect(parseCopilotFlag(true)).toBe(false); // non-string never opts in
    expect(parseCopilotFlag("on")).toBe(true);
    expect(parseCopilotFlag("true")).toBe(true);
    expect(parseCopilotFlag("1")).toBe(true);
  });
});
