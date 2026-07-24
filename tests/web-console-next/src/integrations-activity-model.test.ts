// saas-integrations-console IX5 polish: the Activity timeline model — merging the
// mint ledger + inbound delivery log into one newest-first colored-dot timeline,
// and the relative-time formatting. Pure, no backend.

import type {
  PublicInboundDelivery,
  PublicMintedCredential,
} from "@saas/contracts/integrations";
import { mergeActivity, relativeTime } from "@web-console-next/components/integrations/activity-model";

function mint(overrides: Partial<PublicMintedCredential>): PublicMintedCredential {
  return {
    id: "mint_1",
    orgId: "org_1",
    connectionId: "int_1",
    provider: "supabase",
    template: "db-ro",
    params: null,
    purpose: "api",
    requestedBy: null,
    runId: null,
    jobId: null,
    ttlSeconds: 3600,
    parentKind: null,
    mintedAt: "2026-07-24T09:00:00Z",
    expiresAt: "2026-07-24T10:00:00Z",
    revokedAt: null,
    ...overrides,
  } as PublicMintedCredential;
}

function delivery(overrides: Partial<PublicInboundDelivery>): PublicInboundDelivery {
  return {
    id: "igd_1",
    provider: "github",
    eventType: "push",
    action: null,
    status: "emitted",
    signatureOk: true,
    attempts: 1,
    failureReason: null,
    emittedEventId: "evt_1",
    receivedAt: "2026-07-24T08:00:00Z",
    ...overrides,
  } as PublicInboundDelivery;
}

describe("mergeActivity", () => {
  it("merges + sorts newest-first across sources", () => {
    const events = mergeActivity(
      [mint({ id: "m1", mintedAt: "2026-07-24T09:00:00Z" })],
      [
        delivery({ id: "d1", receivedAt: "2026-07-24T10:00:00Z" }),
        delivery({ id: "d2", receivedAt: "2026-07-24T07:00:00Z" }),
      ],
    );
    expect(events.map((e) => e.id)).toEqual(["d1", "m1", "d2"]);
  });

  it("maps mint purpose to a title; run attribution in the detail", () => {
    expect(mergeActivity([mint({ purpose: "api", runId: "8fa2" })], [])[0]).toMatchObject({
      tone: "info",
      title: "Token minted",
      detail: "db-ro · run 8fa2",
    });
    expect(mergeActivity([mint({ purpose: "secret_resolve" })], [])[0]!.title).toBe("Secret resolved");
    expect(mergeActivity([mint({ purpose: "rotation" })], [])[0]!.title).toBe("Credential rotated");
  });

  it("a revoked mint becomes a revoke event at revokedAt", () => {
    const [e] = mergeActivity([mint({ id: "m9", revokedAt: "2026-07-24T11:00:00Z" })], []);
    expect(e).toMatchObject({ tone: "neutral", title: "Credential revoked", at: "2026-07-24T11:00:00Z" });
  });

  it("maps delivery status to title + tone; action joins the detail", () => {
    expect(mergeActivity([], [delivery({ status: "emitted", eventType: "push" })])[0]).toMatchObject({
      title: "Webhook delivered",
      tone: "success",
      detail: "push",
    });
    expect(mergeActivity([], [delivery({ status: "failed", eventType: "pull_request", action: "opened" })])[0]).toMatchObject({
      title: "Delivery failed",
      tone: "error",
      detail: "pull_request.opened",
    });
  });

  it("degrades on empty/nullish inputs", () => {
    expect(mergeActivity(null, undefined)).toEqual([]);
  });
});

describe("relativeTime", () => {
  const NOW = Date.parse("2026-07-24T12:00:00Z");
  it("buckets by recency", () => {
    expect(relativeTime("2026-07-24T11:59:40Z", NOW)).toBe("just now");
    expect(relativeTime("2026-07-24T11:30:00Z", NOW)).toBe("30m ago");
    expect(relativeTime("2026-07-24T10:00:00Z", NOW)).toBe("2h ago");
    expect(relativeTime("2026-07-23T10:00:00Z", NOW)).toBe("yesterday");
    expect(relativeTime("2026-07-21T12:00:00Z", NOW)).toBe("3d ago");
    expect(relativeTime("2026-06-01T12:00:00Z", NOW)).toBe("Jun 1, 2026");
    expect(relativeTime("not-a-date", NOW)).toBe("");
  });
});
