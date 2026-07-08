import type {
  NotificationProvider,
  ProviderSendContext,
  ProviderSendResult,
} from "@saas/contracts/notifications";
import type { EventSeverity } from "@saas/contracts/event-catalog";

/**
 * Slack incoming-webhook provider (saas-event-streaming ES3).
 *
 * Posts a Block Kit message to a customer-configured incoming-webhook URL.
 * The URL is a bearer credential resolved + decrypted by the caller (the
 * enqueue/retry path) and handed in here per-send — this provider is
 * stateless and never persists or logs the URL.
 *
 * templateData carries only redaction-safe metadata (title, eventType,
 * severity, ruleName, occurredAt) produced by the events-worker rules lane;
 * there are no secrets to render.
 */

export interface SlackWebhookProviderOptions {
  /** The decrypted incoming-webhook URL. Never logged. */
  webhookUrl: string;
  /** Optional console origin for a "view in console" deep link. */
  consoleBaseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const SEVERITY_COLOR: Record<EventSeverity, string> = {
  info: "#6b7280",
  notice: "#2563eb",
  warning: "#d97706",
  error: "#dc2626",
  critical: "#991b1b",
};

function str(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v : "";
}

/**
 * Network errors can embed the target URL (a bearer credential) in their
 * message — R4 forbids that reaching notification_attempts / events / logs.
 * So the transport-failure reason is a FIXED, non-secret string; the HTTP
 * status path (which carries no URL) is bounded separately at the call site.
 */
function boundedNetworkErrorReason(): string {
  return "slack_network_error";
}

/**
 * Build the Block Kit payload from redaction-safe template data. `attachments`
 * carries the severity color bar; `blocks` render the title + context line.
 */
export function buildSlackMessage(
  data: Record<string, unknown>,
  consoleBaseUrl?: string,
): Record<string, unknown> {
  const title = str(data, "title") || str(data, "eventType") || "Platform event";
  const eventType = str(data, "eventType");
  const severityRaw = str(data, "severity");
  const severity = (["info", "notice", "warning", "error", "critical"] as const).includes(
    severityRaw as EventSeverity,
  )
    ? (severityRaw as EventSeverity)
    : "info";
  const ruleName = str(data, "ruleName");
  const occurredAt = str(data, "occurredAt");

  const contextParts = [
    eventType ? `Type: \`${eventType}\`` : "",
    severity ? `Severity: *${severity}*` : "",
    ruleName ? `Rule: ${ruleName}` : "",
    occurredAt ? `At: ${occurredAt}` : "",
  ].filter(Boolean);

  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
  ];
  if (contextParts.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contextParts.join("  ·  ") }],
    });
  }
  const link = consoleBaseUrl ? `${consoleBaseUrl.replace(/\/+$/, "")}/events` : "";
  if (link) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${link}|View in console>` }],
    });
  }

  return {
    text: title, // notification fallback / accessibility
    attachments: [{ color: SEVERITY_COLOR[severity], blocks }],
  };
}

export function createSlackWebhookProvider(
  opts: SlackWebhookProviderOptions,
): NotificationProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: "slack-incoming-webhook",
    async send(ctx: ProviderSendContext): Promise<ProviderSendResult> {
      const message = buildSlackMessage(ctx.templateData, opts.consoleBaseUrl);
      try {
        const response = await doFetch(opts.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
        });
        if (!response.ok) {
          // Slack returns 200 "ok" on success; non-2xx is a delivery failure.
          // The status is a bounded, non-secret signal — the URL is never here.
          return {
            ok: false,
            providerMessageId: null,
            errorReason: `slack_http_${response.status}`,
          };
        }
        // Incoming webhooks have no message id; use the notification id as the
        // opaque traceability reference (never the URL).
        return { ok: true, providerMessageId: `slack:${ctx.notificationId}` };
      } catch {
        return { ok: false, providerMessageId: null, errorReason: boundedNetworkErrorReason() };
      }
    },
  };
}
