// Discord adapter (saas-integration-hub IH10, dormant) — the messaging
// archetype's next entrant, compiled against the seam but with NO live path.
//
// This is the pluggability proof for the messaging capability: adding a second
// messaging provider (channel discovery for the ES ChannelProvider seam)
// required ZERO changes to the delivery split, the notifications-worker
// dispatch, the drain, or the console — only this file and its reserved
// contract id. As with Slack, message DELIVERY stays behind the ES seam in
// notifications-worker (design §4.2); this adapter would only ever add channel
// discovery. The Stripe-after-Polar discipline, per-capability.
//
// connectKind "oauth": a bot install via Discord's OAuth2 with the `bot` +
// `guilds` scopes, exactly as Slack installs its app. Until a connect
// milestone lands, listChannels returns null (the dormant signal callers
// already treat as "no channels available") and the registry never resolves
// this id to a configured adapter.

import type { IntegrationProvider, MessagingCapability } from "./types.js";

/**
 * A dormant messaging adapter for Discord. It declares the capability (so the
 * seam is proven) but discovers nothing — null is the same "unavailable"
 * signal a mid-outage Slack listing returns, so every caller already fails
 * soft on it without a special case.
 */
export function createDiscordProvider(): IntegrationProvider {
  const messaging: MessagingCapability = {
    async listChannels() {
      // No Discord API call is wired — dormant until a connect milestone.
      return null;
    },
  };

  return {
    id: "discord",
    displayName: "Discord",
    connectKind: "oauth",
    capabilities: ["connect", "messaging"],

    messaging,
  };
}
