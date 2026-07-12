// The provider seam, capability-typed (saas-integration-hub IH0, design §2).
//
// Handlers, repo layer, console, SDK, and contracts are provider-generic;
// only the adapter and per-provider credential config know a provider's API.
// One core contract every adapter implements, plus OPTIONAL capability
// objects the registry can interrogate — asking a provider for a capability
// it lacks is a typed `capability_not_supported` error, never a 500.
//
// GitHub is re-expressed against this shape behavior-identically (the legacy
// IG method names remain on the interface, delegating to the capability
// objects, so every shipped handler and test passes unchanged).

import type {
  IntegrationCapability,
  IntegrationConnectKind,
  IntegrationScopeTemplate,
} from "@saas/contracts/integrations";
import type { GithubInstallationFacts } from "../github-app.js";

export interface BuildInstallUrlInput {
  /** Signed single-use connect state to round-trip through the provider. */
  state: string;
}

export interface CompleteConnectInput {
  /** Provider-side installation identifier from the setup callback. */
  installationId: number;
  nowMs: number;
}

/** Verified provider-side facts for an installation (null = unverifiable). */
export type ProviderConnectionFacts = GithubInstallationFacts;

// ── Capabilities ────────────────────────────────────────────

/**
 * Inbound ingress verification + idempotency (IG2 discipline, generalized).
 * Signature schemes differ per provider (GitHub: HMAC of the raw body under
 * X-Hub-Signature-256; Slack: HMAC of `v0:{ts}:{body}` under
 * X-Slack-Signature with a ±300s timestamp window), so verification takes
 * the full header bag and ALWAYS runs over raw bytes before any parse.
 */
export interface InboundCapability {
  verifySignature(
    rawBody: ArrayBuffer,
    headers: Record<string, string | null>,
    nowMs: number,
  ): Promise<boolean>;
}

/** Reveal-once credential material minted by a broker adapter. */
export interface BrokeredCredentialValue {
  /** Provider-shaped material, e.g. { token } — never logged, never cached. */
  credential: Record<string, string>;
  /** Provider-side id of the minted credential (revocation/reconcile). */
  providerRef: string | null;
  /** Actual expiry the provider granted (TTL clamps are provider-side). */
  expiresAt: Date;
}

export type MintCredentialOutcome =
  | { ok: true; value: BrokeredCredentialValue }
  | {
      ok: false;
      /** Stable machine-readable reason (surfaced as a typed API error). */
      reason:
        | "not_implemented"
        | "template_unknown"
        | "parent_grant_insufficient"
        | "provider_error";
      detail?: string;
    };

/**
 * Short-lived scoped credential minting (IH4; generalizes the IG4 broker).
 * Adapters publish named, versioned scope templates; every mint is
 * template-shaped, TTL-clamped, ledgered by the caller — never cached.
 */
export interface CredentialBrokerCapability {
  scopeTemplates(): readonly IntegrationScopeTemplate[];
  mintCredential(input: {
    template: string;
    params: Record<string, unknown>;
    ttlSeconds: number;
    nowMs: number;
  }): Promise<MintCredentialOutcome>;
  /** Best-effort provider-side revoke; TTL is the backstop. */
  revokeCredential(providerRef: string, nowMs: number): Promise<boolean>;
}

/** Channel discovery for the messaging archetype (IH2). Message DELIVERY is
 *  deliberately NOT here — it stays behind the ES ChannelProvider seam in
 *  notifications-worker (design §4.2, the custody/delivery split). */
export interface MessagingCapability {
  listChannels(input: {
    query?: string;
    cursor?: string;
  }): Promise<{ channels: Array<{ externalId: string; name: string; isPrivate: boolean }>; nextCursor: string | null }>;
}

// ── Core adapter contract ───────────────────────────────────

export interface IntegrationProvider {
  id: string;
  displayName: string;
  /** How the connect flow starts (drives the console connect UX). */
  connectKind: IntegrationConnectKind;
  /** What this adapter implements — mirrors which capability objects exist. */
  capabilities: readonly IntegrationCapability[];

  // ── Capability objects (present iff listed in `capabilities`) ──
  inbound?: InboundCapability;
  broker?: CredentialBrokerCapability;
  messaging?: MessagingCapability;

  // ── Connect (IG1) — install-kind legacy surface ───────────
  // These remain the live GitHub connect path; oauth/token connect kinds land
  // with their milestones (IH1 Slack, IH5 Cloudflare, IH6 Supabase).
  buildInstallUrl?(input: BuildInstallUrlInput): string;
  /**
   * Fetch + verify installation facts as the App. Returning null means the
   * installation could not be verified — callers fail closed.
   */
  completeConnect?(input: CompleteConnectInput): Promise<ProviderConnectionFacts | null>;
  /** Best-effort provider-side uninstall on platform revoke. */
  revokeInstallation?(installationId: number, nowMs: number): Promise<boolean>;

  // ── Inbound (IG2) — legacy single-header alias ────────────
  /** @deprecated Delegates to `inbound.verifySignature`; kept so shipped
   *  GitHub handlers/tests pass unchanged during the IH0 re-expression. */
  verifyInboundSignature?(rawBody: ArrayBuffer, signatureHeader: string | null): Promise<boolean>;
}

/** Narrow an adapter to a capability, or null (typed 4xx at the handler). */
export function getCapability<K extends "inbound" | "broker" | "messaging">(
  provider: IntegrationProvider,
  capability: K,
): NonNullable<IntegrationProvider[K]> | null {
  const value = provider[capability];
  return value == null ? null : (value as NonNullable<IntegrationProvider[K]>);
}

export interface ProviderCredentials {
  appId: string;
  appSlug: string;
  privateKeyPem: string;
  webhookSecret: string;
}

/** Slack App per-environment credentials (IH risks D1). */
export interface SlackAppCredentials {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

/** Supabase OAuth app per-environment credentials (IH risks D4). */
export interface SupabaseOauthCredentials {
  clientId: string;
  clientSecret: string;
}
