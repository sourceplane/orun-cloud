import {
  appendEventPage,
  buildEventFilterChips,
  buildEventsQuery,
  EMPTY_EVENT_FILTERS,
  EMPTY_EVENT_LOG,
  eventMatchesClientFilters,
  hasActiveEventFilters,
  hasMoreEvents,
  prependNewEvents,
  type EventFilterFormValues,
  type EventLogState,
} from "@web-console-next/components/events/event-log";
import type { PublicEvent } from "@saas/contracts/events";

function event(over: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: "evt_1",
    type: "state.run.failed",
    version: 1,
    source: "state-worker",
    severity: "error",
    category: "activity",
    title: "Run failed",
    occurredAt: "2026-06-01T10:00:00.000Z",
    actor: { type: "system", id: "sys" },
    orgId: "org_1",
    projectId: null,
    environmentId: null,
    subject: { kind: "run", id: "run_1", name: null },
    requestId: "req_1",
    correlationId: null,
    causationId: null,
    payload: {},
    ...over,
  };
}

function values(over: Partial<EventFilterFormValues> = {}): EventFilterFormValues {
  return { ...EMPTY_EVENT_FILTERS, ...over };
}

describe("buildEventsQuery", () => {
  it("yields an empty query when no filters are set", () => {
    expect(buildEventsQuery(EMPTY_EVENT_FILTERS)).toEqual({});
  });

  it("forwards only the server-supported fields (never severity/category)", () => {
    const q = buildEventsQuery(
      values({
        type: "  scm.* ",
        severity: "warning",
        category: "activity",
        source: "events-worker",
        project: "prj_1",
        environment: "env_1",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      }),
    );
    expect(q).toEqual({
      type: "scm.*",
      source: "events-worker",
      project: "prj_1",
      environment: "env_1",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });
    expect(q).not.toHaveProperty("severity");
    expect(q).not.toHaveProperty("category");
  });

  it("threads a cursor for Load-more", () => {
    expect(buildEventsQuery(values({ type: "scm.*" }), "cur_2")).toEqual({ type: "scm.*", cursor: "cur_2" });
  });
});

describe("eventMatchesClientFilters", () => {
  it("passes everything with a blank floor and category", () => {
    expect(eventMatchesClientFilters(event(), EMPTY_EVENT_FILTERS)).toBe(true);
  });

  it("applies a severity floor (keeps at-or-above)", () => {
    expect(eventMatchesClientFilters(event({ severity: "info" }), values({ severity: "warning" }))).toBe(false);
    expect(eventMatchesClientFilters(event({ severity: "error" }), values({ severity: "warning" }))).toBe(true);
    expect(eventMatchesClientFilters(event({ severity: "warning" }), values({ severity: "warning" }))).toBe(true);
  });

  it("matches on category exactly", () => {
    expect(eventMatchesClientFilters(event({ category: "system" }), values({ category: "activity" }))).toBe(false);
    expect(eventMatchesClientFilters(event({ category: "activity" }), values({ category: "activity" }))).toBe(true);
  });

  it("ignores an invalid severity floor", () => {
    expect(eventMatchesClientFilters(event({ severity: "info" }), values({ severity: "bogus" }))).toBe(true);
  });
});

describe("hasActiveEventFilters", () => {
  it("is false for a blank form and true when any field has content", () => {
    expect(hasActiveEventFilters(EMPTY_EVENT_FILTERS)).toBe(false);
    expect(hasActiveEventFilters(values({ severity: "warning" }))).toBe(true);
  });
});

describe("buildEventFilterChips", () => {
  it("emits one chip per active field including client-side filters", () => {
    const chips = buildEventFilterChips(values({ type: "scm.*", severity: "warning", category: "activity" }));
    expect(chips.map((c) => c.key)).toEqual(["type", "severity", "category"]);
    expect(chips[0]!.label).toBe("type: scm.*");
    expect(chips[1]!.label).toBe("severity ≥: warning");
  });
});

describe("appendEventPage", () => {
  it("replaces on reset and dedupes by id on append", () => {
    const first = appendEventPage(EMPTY_EVENT_LOG, { events: [event({ id: "a" })], cursor: "c1" }, true);
    expect(first.events.map((e) => e.id)).toEqual(["a"]);
    const more = appendEventPage(first, { events: [event({ id: "a" }), event({ id: "b" })], cursor: null });
    expect(more.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(more.cursor).toBeNull();
  });
});

describe("prependNewEvents", () => {
  it("prepends only unseen events and keeps the cursor", () => {
    const state: EventLogState = { events: [event({ id: "a" })], cursor: "c1" };
    const next = prependNewEvents(state, [event({ id: "b" }), event({ id: "a" })]);
    expect(next.events.map((e) => e.id)).toEqual(["b", "a"]);
    expect(next.cursor).toBe("c1");
  });

  it("returns the same object when nothing is new", () => {
    const state: EventLogState = { events: [event({ id: "a" })], cursor: "c1" };
    expect(prependNewEvents(state, [event({ id: "a" })])).toBe(state);
  });
});

describe("hasMoreEvents", () => {
  it("reflects cursor presence", () => {
    expect(hasMoreEvents({ events: [], cursor: "c1" })).toBe(true);
    expect(hasMoreEvents({ events: [], cursor: null })).toBe(false);
  });
});
