import { buildSlackMessage, createSlackWebhookProvider } from "@notifications-worker/providers/slack-webhook";
import type { ProviderSendContext } from "@saas/contracts/notifications";

const WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/xxxSECRETxxx";

function ctx(overrides?: Partial<ProviderSendContext>): ProviderSendContext {
  return {
    notificationId: "ntf-1",
    orgId: "org-1",
    category: "product",
    templateKey: "event.notification",
    templateData: {
      title: "PR #7 merged in acme/api",
      eventType: "scm.pull_request.merged",
      severity: "notice",
      ruleName: "PR merges",
      occurredAt: "2026-07-05T10:00:00.000Z",
    },
    recipient: { channel: "slack", address: "chan_0123456789abcdef0123456789abcdef" },
    ...overrides,
  };
}

describe("buildSlackMessage", () => {
  it("renders Block Kit with title, context, severity color, and fallback text", () => {
    const msg = buildSlackMessage(
      { title: "T", eventType: "scm.push", severity: "error", ruleName: "R", occurredAt: "now" },
      "https://app.test",
    );
    expect(msg.text).toBe("T");
    const attachments = msg.attachments as Array<Record<string, unknown>>;
    expect(attachments[0]!.color).toBe("#dc2626"); // error
    const blocks = attachments[0]!.blocks as Array<Record<string, unknown>>;
    expect(JSON.stringify(blocks)).toContain("*T*");
    expect(JSON.stringify(blocks)).toContain("scm.push");
    expect(JSON.stringify(blocks)).toContain("https://app.test/events");
  });

  it("defaults unknown severity to info color", () => {
    const msg = buildSlackMessage({ title: "T", severity: "bogus" });
    const attachments = msg.attachments as Array<Record<string, unknown>>;
    expect(attachments[0]!.color).toBe("#6b7280");
  });
});

describe("createSlackWebhookProvider", () => {
  it("POSTs to the webhook URL and returns ok on 2xx (no URL in the result)", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body ?? "");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createSlackWebhookProvider({ webhookUrl: WEBHOOK_URL, fetchImpl });
    const result = await provider.send(ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerMessageId).toBe("slack:ntf-1");
      // The URL must never appear in the returned traceability reference.
      expect(result.providerMessageId).not.toContain("hooks.slack.com");
    }
    expect(capturedUrl).toBe(WEBHOOK_URL);
    expect(capturedBody).toContain("PR #7 merged");
  });

  it("maps non-2xx to a bounded failure carrying only the status, never the URL", async () => {
    const fetchImpl = (async () => new Response("no_service", { status: 404 })) as unknown as typeof fetch;
    const provider = createSlackWebhookProvider({ webhookUrl: WEBHOOK_URL, fetchImpl });
    const result = await provider.send(ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorReason).toBe("slack_http_404");
      expect(result.errorReason).not.toContain("hooks.slack.com");
    }
  });

  it("maps a network throw to a FIXED reason that cannot leak the URL", async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect failed to ${WEBHOOK_URL}`);
    }) as unknown as typeof fetch;
    const provider = createSlackWebhookProvider({ webhookUrl: WEBHOOK_URL, fetchImpl });
    const result = await provider.send(ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // R4: the raw error (which embedded the URL) must never surface.
      expect(result.errorReason).toBe("slack_network_error");
      expect(result.errorReason).not.toContain("hooks.slack.com");
    }
  });
});
