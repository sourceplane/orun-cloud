// webhook_deliveries_list

import { describe, expect, it, vi } from "vitest";

import { dataOf, errorDetailOf, forbidden, runTool } from "./helpers.js";

const endpoint = { id: "whep_1", url: "https://hooks.example.test", status: "active" };
const attempt = { id: "wha_1", endpointId: "whep_1", status: "failed", attemptNumber: 3 };

describe("webhook_deliveries_list", () => {
  it("pages through an endpoint's delivery attempts with cursor passthrough", async () => {
    const listDeliveryAttemptsPage = vi
      .fn()
      .mockResolvedValue({ deliveryAttempts: [attempt], nextCursor: "next_w" });
    const result = await runTool(
      "webhook_deliveries_list",
      { workspace: "ws_1", endpoint: "whep_1", cursor: "prev_w", limit: 50 },
      { webhooks: { listDeliveryAttemptsPage } },
    );
    expect(listDeliveryAttemptsPage).toHaveBeenCalledWith("ws_1", "whep_1", {
      cursor: "prev_w",
      limit: 50,
    });
    expect(dataOf(result)).toEqual({
      deliveryAttempts: [attempt],
      meta: { cursor: "next_w" },
    });
  });

  it("lists endpoints when no endpoint id is given", async () => {
    const listEndpoints = vi
      .fn()
      .mockResolvedValue({ endpoints: [endpoint], nextCursor: null });
    const result = await runTool(
      "webhook_deliveries_list",
      { workspace: "ws_1" },
      { webhooks: { listEndpoints } },
    );
    expect(listEndpoints).toHaveBeenCalledWith("ws_1");
    expect(dataOf(result)).toEqual({ endpoints: [endpoint], meta: { cursor: null } });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "webhook_deliveries_list",
      { workspace: "ws_1", endpoint: "whep_1" },
      { webhooks: { listDeliveryAttemptsPage: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});
