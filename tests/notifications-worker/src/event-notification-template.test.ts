import { renderEmailTemplate } from "@notifications-worker/templates/index";

describe("event.notification template (saas-event-streaming ES2)", () => {
  const data = {
    title: "PR #7 merged in acme/api",
    eventType: "scm.pull_request.merged",
    severity: "notice",
    ruleName: "PR merges",
    occurredAt: "2026-07-04T10:00:00.000Z",
    sourceEventId: "evt_abc",
  };

  it("renders subject, text, and html from redaction-safe metadata", () => {
    const rendered = renderEmailTemplate("event.notification", data, { brandName: "Orun Cloud" });
    expect(rendered).not.toBeNull();
    expect(rendered!.subject).toBe("[notice] PR #7 merged in acme/api");
    expect(rendered!.text).toContain("Event: scm.pull_request.merged");
    expect(rendered!.text).toContain("Matched rule: PR merges");
    expect(rendered!.html).toContain("PR #7 merged in acme/api");
    expect(rendered!.html).toContain("notification rule you configured");
  });

  it("plain info severity gets no bracket prefix", () => {
    const rendered = renderEmailTemplate("event.notification", { ...data, severity: "info" });
    expect(rendered!.subject).toBe("PR #7 merged in acme/api");
  });

  it("escapes html in event-derived strings", () => {
    const rendered = renderEmailTemplate("event.notification", {
      ...data,
      title: '<script>alert("x")</script>',
    });
    expect(rendered!.html).not.toContain("<script>");
    expect(rendered!.html).toContain("&lt;script&gt;");
  });
});
