// audit_search / events_search / security_events_list

import { describe, expect, it, vi } from "vitest";

import { dataOf, errorDetailOf, forbidden, runTool } from "./helpers.js";

const auditEntry = { id: "aud_1", eventType: "project.created", actorId: "usr_1" };
const event = { id: "evt_1", type: "run.finished", source: "state" };
const securityEvent = { id: "sev_1", eventType: "session.created", outcome: "success" };

describe("audit_search", () => {
  it("threads filters, cursor, and limit into the org audit page read", async () => {
    const listAuditEntriesPage = vi
      .fn()
      .mockResolvedValue({ entries: [auditEntry], cursor: "next_a" });
    const result = await runTool(
      "audit_search",
      {
        workspace: "ws_1",
        actorId: "usr_1",
        eventType: "project.created",
        from: "2026-01-01T00:00:00Z",
        cursor: "prev_a",
        limit: 10,
      },
      { events: { listAuditEntriesPage } },
    );
    expect(listAuditEntriesPage).toHaveBeenCalledWith("ws_1", {
      by: "org",
      actorId: "usr_1",
      eventType: "project.created",
      from: "2026-01-01T00:00:00Z",
      cursor: "prev_a",
      limit: 10,
    });
    expect(dataOf(result)).toEqual({
      auditEntries: [auditEntry],
      meta: { cursor: "next_a" },
    });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "audit_search",
      { workspace: "ws_1" },
      { events: { listAuditEntriesPage: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("events_search", () => {
  it("lists a single page with filters and cursor passthrough", async () => {
    const listEventsPage = vi.fn().mockResolvedValue({ events: [event], cursor: "next_e" });
    const result = await runTool(
      "events_search",
      { workspace: "ws_1", type: "run.*", project: "prj_a", cursor: "prev_e", limit: 20 },
      { events: { listEventsPage } },
    );
    expect(listEventsPage).toHaveBeenCalledWith("ws_1", {
      type: "run.*",
      project: "prj_a",
      cursor: "prev_e",
      limit: 20,
    });
    expect(dataOf(result)).toEqual({ events: [event], meta: { cursor: "next_e" } });
  });

  it("fetches one event by id when eventId is given", async () => {
    const getEvent = vi.fn().mockResolvedValue({ event });
    const listEventsPage = vi.fn();
    const result = await runTool(
      "events_search",
      { workspace: "ws_1", eventId: "evt_1" },
      { events: { getEvent, listEventsPage } },
    );
    expect(getEvent).toHaveBeenCalledWith("ws_1", "evt_1");
    expect(listEventsPage).not.toHaveBeenCalled();
    expect(dataOf(result)).toEqual({ event });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "events_search",
      { workspace: "ws_1" },
      { events: { listEventsPage: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("security_events_list", () => {
  it("passes cursor/limit through and returns the next cursor", async () => {
    const listPage = vi
      .fn()
      .mockResolvedValue({ securityEvents: [securityEvent], nextCursor: "next_s" });
    const result = await runTool(
      "security_events_list",
      { cursor: "prev_s", limit: 15 },
      { securityEvents: { listPage } },
    );
    expect(listPage).toHaveBeenCalledWith({ cursor: "prev_s", limit: 15 });
    expect(dataOf(result)).toEqual({
      securityEvents: [securityEvent],
      meta: { cursor: "next_s" },
    });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "security_events_list",
      {},
      { securityEvents: { listPage: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});
