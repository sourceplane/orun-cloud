// Agents presentation model (saas-agents AG7): the tone/label mappings the
// fleet view renders from — every state in the closed vocabulary maps, and
// the provider meta carries the two AG12 providers.

import { connectionTone, sessionLabel, sessionTone, PROVIDER_META } from "@web-console-next/lib/agents/model";
import { AGENT_SESSION_STATES, AGENT_PROVIDERS, PROVIDER_CONNECTION_STATUSES } from "@saas/contracts/agents";

describe("agents presentation model", () => {
  it("maps every session state in the closed vocabulary to a tone", () => {
    for (const state of AGENT_SESSION_STATES) {
      expect(["success", "warning", "error", "info", "neutral"]).toContain(sessionTone(state));
    }
  });

  it("reads like a fleet dashboard: running is healthy, failed/expired are errors", () => {
    expect(sessionTone("running")).toBe("success");
    expect(sessionTone("failed")).toBe("error");
    expect(sessionTone("expired")).toBe("error");
    expect(sessionTone("awaiting_approval")).toBe("warning");
    expect(sessionTone("completed")).toBe("neutral");
  });

  it("labels states human-readably", () => {
    expect(sessionLabel("awaiting_approval")).toBe("Awaiting approval");
    expect(sessionLabel("provisioning")).toBe("Provisioning");
  });

  it("maps every connection status to a tone", () => {
    for (const status of PROVIDER_CONNECTION_STATUSES) {
      expect(["success", "warning", "error"]).toContain(connectionTone(status));
    }
    expect(connectionTone("verified")).toBe("success");
    expect(connectionTone("invalid")).toBe("error");
  });

  it("carries card meta for exactly the AG12 providers", () => {
    expect(Object.keys(PROVIDER_META).sort()).toEqual([...AGENT_PROVIDERS].sort());
  });
});
