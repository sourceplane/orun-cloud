import {
  validateCustomEvent,
  MAX_CUSTOM_EVENT_PAYLOAD_BYTES,
  type NormalizedCustomEvent,
} from "@saas/contracts/events";
import { eventCategory } from "@saas/contracts/event-catalog";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");

function ok(input: unknown, nowMs?: number): NormalizedCustomEvent {
  const result = validateCustomEvent(input, nowMs);
  if (!result.ok) throw new Error(`expected ok, got ${result.field}: ${result.reason}`);
  return result.value;
}

describe("validateCustomEvent", () => {
  it("accepts a minimal valid custom event and applies defaults", () => {
    const value = ok({ type: "custom.order.placed" });
    expect(value.type).toBe("custom.order.placed");
    expect(value.title).toBe("custom.order.placed"); // defaults to type
    expect(value.severity).toBe("info");
    expect(value.subject).toEqual({ kind: "custom", id: "custom", name: null });
    expect(value.projectId).toBeNull();
    expect(value.environmentId).toBeNull();
    expect(value.payload).toEqual({});
    expect(value.dedupKey).toBeNull();
    expect(value.correlationId).toBeNull();
    expect(value.causationId).toBeNull();
    expect(value.idempotencyKey).toBeNull();
    expect(value.occurredAt).toBeNull();
  });

  it("normalizes a fully-specified event", () => {
    const value = ok({
      type: "custom.deploy.finished",
      title: "Deploy finished",
      severity: "warning",
      subject: { kind: "service", id: "svc-1", name: "api" },
      projectId: "prj_00000000000000000000000000000001",
      environmentId: "env_00000000000000000000000000000002",
      payload: { region: "us-east-1" },
      dedupKey: "deploy-42",
      correlationId: "corr-1",
      causationId: "cause-1",
      idempotencyKey: "idem-1",
      occurredAt: "2026-07-05T11:59:00Z",
    }, NOW);
    expect(value.severity).toBe("warning");
    expect(value.subject).toEqual({ kind: "service", id: "svc-1", name: "api" });
    expect(value.payload).toEqual({ region: "us-east-1" });
    expect(value.occurredAt).toBe("2026-07-05T11:59:00.000Z"); // normalized ISO
    expect(value.idempotencyKey).toBe("idem-1");
  });

  it("rejects a non-object body", () => {
    for (const bad of [null, undefined, 42, "x", [1, 2]]) {
      const result = validateCustomEvent(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.field).toBe("body");
    }
  });

  it("rejects a reserved (non-custom) namespace with a namespace reason", () => {
    const result = validateCustomEvent({ type: "billing.invoice_paid" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("type");
      expect(result.reason).toBe("Only the custom.* namespace may be ingested");
    }
  });

  it("rejects a malformed type", () => {
    const result = validateCustomEvent({ type: "NotAType" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("type");
  });

  it("rejects an oversized payload", () => {
    const big = "x".repeat(MAX_CUSTOM_EVENT_PAYLOAD_BYTES + 100);
    const result = validateCustomEvent({ type: "custom.big", payload: { blob: big } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("payload");
      expect(result.reason).toBe("Payload exceeds 32KiB limit");
    }
  });

  it("rejects a bad severity", () => {
    const result = validateCustomEvent({ type: "custom.x", severity: "fatal" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("severity");
  });

  it("rejects a future occurredAt beyond skew when nowMs is provided", () => {
    const future = new Date(NOW + 10 * 60_000).toISOString();
    const result = validateCustomEvent({ type: "custom.x", occurredAt: future }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("occurredAt");
      expect(result.reason).toBe("occurredAt cannot be in the future");
    }
  });

  it("allows a future occurredAt when nowMs is omitted (skew check skipped)", () => {
    const future = new Date(NOW + 10 * 60_000).toISOString();
    const value = ok({ type: "custom.x", occurredAt: future });
    expect(value.occurredAt).toBe(future);
  });

  it("rejects an unparseable occurredAt", () => {
    const result = validateCustomEvent({ type: "custom.x", occurredAt: "not-a-date" }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("occurredAt");
  });

  it("rejects an invalid subject", () => {
    const result = validateCustomEvent({ type: "custom.x", subject: { kind: "", id: "y" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("subject");
  });
});

describe("eventCategory", () => {
  it("returns the catalog category for a registered type", () => {
    expect(eventCategory("organization.created")).toBe("activity");
    expect(eventCategory("api_key.created")).toBe("security");
  });

  it("returns custom for a custom.* type", () => {
    expect(eventCategory("custom.order.placed")).toBe("custom");
  });

  it("returns system for an unrecognized type", () => {
    expect(eventCategory("totally.unknown")).toBe("system");
  });
});
