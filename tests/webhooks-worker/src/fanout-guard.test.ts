import { isWebhookLifecycleEvent, isFanoutSuppressedEvent } from "@webhooks-worker/delivery";

describe("fanout recursion guard (generalized in saas-event-streaming ES1)", () => {
  it("keeps the original webhook lifecycle suppression", () => {
    expect(isWebhookLifecycleEvent("webhook.delivery_succeeded")).toBe(true);
    expect(isWebhookLifecycleEvent("webhook.delivery_failed")).toBe(true);
    expect(isWebhookLifecycleEvent("webhook.disabled")).toBe(true);
    expect(isFanoutSuppressedEvent("webhook.delivery_succeeded")).toBe(true);
  });

  it("suppresses the event-streaming meta namespaces", () => {
    expect(isFanoutSuppressedEvent("event.delivery_failed")).toBe(true);
    expect(isFanoutSuppressedEvent("dead_letter.created")).toBe(true);
    expect(isFanoutSuppressedEvent("dead_letter.replayed")).toBe(true);
  });

  it("does not suppress customer-relevant events", () => {
    expect(isFanoutSuppressedEvent("webhook_endpoint.created")).toBe(false);
    expect(isFanoutSuppressedEvent("scm.push")).toBe(false);
    expect(isFanoutSuppressedEvent("notification.sent")).toBe(false);
    // "events" / "dead_letters" as leading path segments must be exact
    // namespace matches, not substring matches.
    expect(isFanoutSuppressedEvent("eventing.custom")).toBe(false);
  });
});
