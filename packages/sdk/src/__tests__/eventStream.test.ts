// Tests for the ES5b SDK surface: the event STREAM methods on EventsClient
// (emit / list / listPage / iter / export / get), plus the EventGroupsClient,
// NotificationRulesClient, and NotificationChannelsClient. URL-shape,
// idempotency passthrough, pagination, and write-only-secret discipline.

import { describe, expect, it, vi } from "vitest";

import { OrunCloud, EVENT_ITERATOR_MAX_PAGES } from "../index.js";
import type { PublicEvent } from "@saas/contracts/events";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(response: Response): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response.clone();
  });
  return { fetch: fn, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function client(fetchImpl: typeof fetch): OrunCloud {
  return new OrunCloud({ baseUrl: "https://api.test", fetch: fetchImpl });
}

function pageResponder(
  pages: ReadonlyArray<{ events: ReadonlyArray<Partial<PublicEvent>>; cursor: string | null }>,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (i >= pages.length) {
      throw new Error(`pageResponder: unexpected request (i=${i}, url=${String(input)})`);
    }
    const page = pages[i]!;
    i += 1;
    return jsonResponse({
      data: { events: page.events },
      meta: { requestId: `req_${i}`, cursor: page.cursor },
    });
  });
  return { fetch: fn, calls };
}

function evt(id: string): Partial<PublicEvent> {
  return { id, type: "custom.order.placed", severity: "info", occurredAt: "2026-01-01T00:00:00.000Z" };
}

// ---------------------------------------------------------------------------
// EventsClient — event stream
// ---------------------------------------------------------------------------

describe("EventsClient.emitEvent", () => {
  it("POSTs to the org events collection and returns the created event", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { event: evt("evt_1") }, meta: { requestId: "req_1" } }, { status: 201 }),
    );
    const data = await client(fetch).events.emitEvent("org_1", { type: "custom.order.placed", title: "v42" });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/events");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ type: "custom.order.placed", title: "v42" });
    expect(data.event.id).toBe("evt_1");
  });

  it("forwards opts.idempotencyKey as the Idempotency-Key header", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { event: evt("evt_1") }, meta: { requestId: "req_1" } }, { status: 201 }),
    );
    await client(fetch).events.emitEvent("org_1", { type: "custom.x" }, { idempotencyKey: "idem-9" });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("idempotency-key")).toBe("idem-9");
  });
});

describe("EventsClient.listEvents", () => {
  it("threads only defined filters into the query string", async () => {
    const { fetch, calls } = captureFetch(jsonResponse({ data: { events: [] }, meta: { requestId: "r", cursor: null } }));
    await client(fetch).events.listEvents("org_1", {
      type: "custom.*",
      project: "prj_abc",
      environment: "env_def",
      from: "2026-01-01T00:00:00.000Z",
      limit: 25,
    });
    const url = calls[0]!.url;
    expect(url).toContain("type=custom");
    expect(url).toContain("project=prj_abc");
    expect(url).toContain("environment=env_def");
    expect(url).toContain("from=2026-01-01T00%3A00%3A00.000Z");
    expect(url).toContain("limit=25");
    expect(url).not.toContain("source=");
    expect(url).not.toContain("cursor=");
  });
});

describe("EventsClient.listEventsPage", () => {
  it("surfaces the server cursor from meta", async () => {
    const { fetch } = pageResponder([{ events: [evt("evt_1")], cursor: "cur_2" }]);
    const page = await client(fetch).events.listEventsPage("org_1");
    expect(page.events.map((e) => e.id)).toEqual(["evt_1"]);
    expect(page.cursor).toBe("cur_2");
  });
});

describe("EventsClient.iterEvents", () => {
  it("walks >= 2 pages and preserves order", async () => {
    const { fetch, calls } = pageResponder([
      { events: [evt("evt_1"), evt("evt_2")], cursor: "cur_2" },
      { events: [evt("evt_3")], cursor: null },
    ]);
    const ids: string[] = [];
    for await (const e of client(fetch).events.iterEvents("org_1")) ids.push(e.id);
    expect(ids).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("cursor=cur_2");
  });

  it("aborts on a repeated cursor", async () => {
    const { fetch } = pageResponder([
      { events: [evt("evt_1")], cursor: "cur_X" },
      { events: [evt("evt_2")], cursor: "cur_X" },
    ]);
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const e of client(fetch).events.iterEvents("org_1")) seen.push(e.id);
      })(),
    ).rejects.toThrow(/repeated cursor/);
    expect(seen).toEqual(["evt_1"]);
  });

  it("exposes a page cap >= 1000", () => {
    expect(EVENT_ITERATOR_MAX_PAGES).toBeGreaterThanOrEqual(1000);
  });
});

describe("EventsClient.exportEventsNdjson", () => {
  it("yields one NDJSON line per event across pages", async () => {
    const { fetch } = pageResponder([
      { events: [evt("evt_1"), evt("evt_2")], cursor: "cur_2" },
      { events: [evt("evt_3")], cursor: null },
    ]);
    const lines: string[] = [];
    for await (const line of client(fetch).events.exportEventsNdjson("org_1")) lines.push(line);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
    expect(JSON.parse(lines[0]!.trimEnd()).id).toBe("evt_1");
  });
});

describe("EventsClient.getEvent", () => {
  it("GETs the single-event path with an encoded id", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { event: evt("evt_1") }, meta: { requestId: "r" } }),
    );
    const data = await client(fetch).events.getEvent("org_1", "evt_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/events/evt_1");
    expect(calls[0]!.init.method).toBe("GET");
    expect(data.event.id).toBe("evt_1");
  });
});

// ---------------------------------------------------------------------------
// EventGroupsClient
// ---------------------------------------------------------------------------

describe("EventGroupsClient", () => {
  it("list threads status + limit and returns groups", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { eventGroups: [{ id: "grp_1" }] }, meta: { requestId: "r", cursor: null } }),
    );
    const data = await client(fetch).eventGroups.list("org_1", { status: "open", limit: 10 });
    expect(calls[0]!.url).toContain("/v1/organizations/org_1/event-groups");
    expect(calls[0]!.url).toContain("status=open");
    expect(calls[0]!.url).toContain("limit=10");
    expect(data.eventGroups[0]!.id).toBe("grp_1");
  });

  it("get hits the single-group path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { eventGroup: { id: "grp_1" }, members: [] }, meta: { requestId: "r" } }),
    );
    const data = await client(fetch).eventGroups.get("org_1", "grp_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/event-groups/grp_1");
    expect(data.eventGroup.id).toBe("grp_1");
  });

  it("iter walks pages via the envelope cursor", async () => {
    let i = 0;
    const fn: typeof fetch = vi.fn(async () => {
      i += 1;
      return jsonResponse({
        data: { eventGroups: [{ id: `grp_${i}` }] },
        meta: { requestId: `r${i}`, cursor: i < 2 ? `cur_${i}` : null },
      });
    });
    const ids: string[] = [];
    for await (const g of client(fn).eventGroups.iter("org_1")) ids.push(g.id);
    expect(ids).toEqual(["grp_1", "grp_2"]);
  });
});

// ---------------------------------------------------------------------------
// NotificationRulesClient
// ---------------------------------------------------------------------------

describe("NotificationRulesClient", () => {
  it("list GETs the org rules collection", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { notificationRules: [] }, meta: { requestId: "r", cursor: null } }),
    );
    await client(fetch).notificationRules.list("org_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/notification-rules");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("create POSTs the body and forwards the idempotency key", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { notificationRule: { id: "rule_1" } }, meta: { requestId: "r" } }, { status: 201 }),
    );
    await client(fetch).notificationRules.create(
      "org_1",
      { name: "deploys", eventTypes: ["custom.deploy.*"], minSeverity: "notice", targets: [{ kind: "email", ref: "a@b.co" }] },
      { idempotencyKey: "idem-1" },
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toBe("idem-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ name: "deploys" });
  });

  it("update PATCHes the single-rule path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { notificationRule: { id: "rule_1" } }, meta: { requestId: "r" } }),
    );
    await client(fetch).notificationRules.update("org_1", "rule_1", { status: "disabled" });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/notification-rules/rule_1");
    expect(calls[0]!.init.method).toBe("PATCH");
  });

  it("delete DELETEs the single-rule path", async () => {
    const { fetch, calls } = captureFetch(jsonResponse({ data: { deleted: true }, meta: { requestId: "r" } }));
    await client(fetch).notificationRules.delete("org_1", "rule_1");
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("test POSTs to the rule test route", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { matched: true, ruleStatus: "enabled", matchedTargets: [] }, meta: { requestId: "r" } }),
    );
    const data = await client(fetch).notificationRules.test("org_1", "rule_1", { type: "custom.deploy" });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/notification-rules/rule_1/test");
    expect(calls[0]!.init.method).toBe("POST");
    expect(data.matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NotificationChannelsClient
// ---------------------------------------------------------------------------

describe("NotificationChannelsClient", () => {
  it("list GETs the org channels collection and never surfaces a secret", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({
        data: { notificationChannels: [{ id: "chan_1", kind: "slack_incoming_webhook", name: "ops", status: "active" }] },
        meta: { requestId: "r" },
      }),
    );
    const data = await client(fetch).notificationChannels.list("org_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/notification-channels");
    // The public channel shape carries no webhook URL / ciphertext.
    expect(data.notificationChannels[0]).not.toHaveProperty("webhookUrl");
    expect(data.notificationChannels[0]).not.toHaveProperty("config_ciphertext");
  });

  it("create POSTs the write-only webhookUrl body", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { notificationChannel: { id: "chan_1" } }, meta: { requestId: "r" } }, { status: 201 }),
    );
    await client(fetch).notificationChannels.create("org_1", {
      name: "ops",
      webhookUrl: "https://hooks.slack.com/services/T/B/xxx",
    });
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ webhookUrl: "https://hooks.slack.com/services/T/B/xxx" });
  });

  it("testSend POSTs to the channel test route", async () => {
    const { fetch, calls } = captureFetch(jsonResponse({ data: { verified: true }, meta: { requestId: "r" } }));
    const data = await client(fetch).notificationChannels.testSend("org_1", "chan_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/notification-channels/chan_1/test");
    expect(calls[0]!.init.method).toBe("POST");
    expect(data.verified).toBe(true);
  });
});
