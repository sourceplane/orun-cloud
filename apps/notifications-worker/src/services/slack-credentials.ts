// slack_app delivery-credential client (saas-integration-hub IH2, design
// §4.2): fetch the bot token for a channel's connection over the
// integrations-worker service binding. The token lives in THIS isolate's
// memory for the duration of one send and is never persisted or logged —
// custody stays with integrations-worker.

const CREDENTIALS_URL = "https://integrations.internal/internal/slack/credentials";

export type SlackDeliveryCredentials =
  | { ok: true; botToken: string }
  | { ok: false; reason: string };

export async function fetchSlackDeliveryCredentials(
  binding: Fetcher,
  orgPublicId: string,
  connectionPublicId: string,
): Promise<SlackDeliveryCredentials> {
  try {
    const response = await binding.fetch(CREDENTIALS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-caller": "notifications-worker",
      },
      body: JSON.stringify({ orgId: orgPublicId, connectionId: connectionPublicId }),
    });
    if (!response.ok) return { ok: false, reason: `credentials_http_${response.status}` };
    const body = (await response.json()) as {
      data?: { ok?: boolean; botToken?: string; reason?: string };
    };
    if (body.data?.ok === true && typeof body.data.botToken === "string") {
      return { ok: true, botToken: body.data.botToken };
    }
    return { ok: false, reason: `credentials_${body.data?.reason ?? "unavailable"}` };
  } catch {
    return { ok: false, reason: "credentials_network_error" };
  }
}
