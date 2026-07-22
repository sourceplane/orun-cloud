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
  SecretMode,
} from "@saas/contracts/integrations";
import type { GithubInstallationFacts } from "../github-app.js";
import type { SlackOauthGrant } from "./slack.js";

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

// ── OAuth-kind connect (IH1 Slack; IH6 Supabase) ────────────

export interface BuildAuthorizeUrlInput {
  /** Signed single-use connect state to round-trip through the provider. */
  state: string;
  /** Our public callback URL — must match the provider app's configuration. */
  redirectUri: string;
  /** PKCE S256 code challenge (IH6 Supabase) — base64url(SHA-256(verifier)). */
  codeChallenge?: string;
}

export interface ExchangeOauthCodeInput {
  /** Authorization code from the provider's redirect. */
  code: string;
  /** The exact redirect URI the authorize URL carried (providers verify it). */
  redirectUri: string;
  nowMs: number;
}

/** Verified grant from an OAuth code exchange (null = provider refused).
 *  Slack-shaped today, the same way ProviderConnectionFacts is GitHub-shaped;
 *  IH6 widens this to a union when the Supabase exchange lands. */
export type ProviderOauthGrant = SlackOauthGrant;

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
  /**
   * When the mint consumed a ROTATING parent (Supabase refresh tokens rotate
   * on use), the NEW parent credential the provider handed back — the broker
   * handler must re-envelope it into custody or the next mint fails with
   * `parent_grant_insufficient`. Never logged; lives only for the one call.
   */
  rotatedParentCredential?: string;
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

/** Decrypted parent credential + its provider-side ref, handed to broker
 *  calls by the mint handler from custody (never held by the adapter). */
export interface ParentCredentialContext {
  /** The decrypted parent credential (Cloudflare parent token, Supabase
   *  refresh token). Never logged; lives only for the one call. */
  credential: string;
  /** Provider-side anchor from the custody row (e.g. Cloudflare account id). */
  externalRef: string | null;
  /** Custody kind the credential was read from (SI2). Adapters with more
   *  than one custody posture (Cloudflare: service/parent token vs refresh
   *  token) dispatch on THIS — never on environment configuration — so an
   *  upgraded connection can never re-enter the deprecated refresh flow. */
  kind?: string;
}

export interface MintCredentialInput {
  template: string;
  params: Record<string, unknown>;
  ttlSeconds: number;
  nowMs: number;
  /** Present for providers whose mints derive from a parent credential. */
  parent?: ParentCredentialContext;
  /** Provider-side name for the minted credential —
   *  `orun/{org}/{template}/{mintId}` — so the IH9 orphan sweep can
   *  reconcile provider truth against the ledger. */
  mintRef?: string;
}

/**
 * Short-lived scoped credential minting (IH4; generalizes the IG4 broker).
 * Adapters publish named, versioned scope templates; every mint is
 * template-shaped, TTL-clamped, ledgered by the caller — never cached.
 */
export interface CredentialBrokerCapability {
  scopeTemplates(): readonly IntegrationScopeTemplate[];
  mintCredential(input: MintCredentialInput): Promise<MintCredentialOutcome>;
  /** Best-effort provider-side revoke; TTL is the backstop. */
  revokeCredential(
    providerRef: string,
    nowMs: number,
    parent?: ParentCredentialContext,
  ): Promise<boolean>;
}

/**
 * Secret-source DESCRIBE capability (saas-secrets-platform SP0). Pure data +
 * the shared scope-template catalog — the substrate reads this to derive what
 * it used to hardcode (BROKER_CAPABLE_PROVIDERS / ALLOWED_ROTATION_PROVIDERS /
 * SCOPE_TEMPLATE_CATALOG). Never mints; the PRODUCE verb stays on `broker`.
 */
export interface SecretsCapability {
  /** Canonical scope-template catalog (the same list `broker.scopeTemplates`
   *  returns — unified here as the single source of truth). */
  scopeTemplates(): readonly IntegrationScopeTemplate[];
  /** Which stored/served modes this provider's mint can back. */
  supportedModes: readonly SecretMode[];
  /** Materialize target ids a rotated value can be delivered into (RS deliver);
   *  empty for providers that only serve per-run consumers. */
  deliveryTargets(): readonly string[];
  /** Default substrate surface, or a surface the integration registers itself. */
  authoring: "declarative" | "custom";
}

// ── Service-identity provisioning (SI, sub-epics/service-identity-bootstrap) ──

/** A provisioned provider-side service identity: the durable, org-owned
 *  operating credential that replaces user-derived OAuth custody. */
export interface ProvisionedServiceIdentity {
  /** The credential value to envelope into custody. Never logged. */
  credential: string;
  /** Custody kind the credential must be stored under
   *  (e.g. "cloudflare_service_token"). */
  kind: string;
  /** Custody anchor for the row's external_ref — the same anchor mints use
   *  (Cloudflare: the ACCOUNT external id, not the token id). */
  externalRef: string | null;
  /** Provider-side id of the identity itself (verify/rotate/revoke anchor;
   *  Cloudflare: the created token's id — recorded in provider facts). */
  providerRef: string | null;
  /** Provider-side expiry, when the identity has one (null = durable). */
  expiresAt: Date | null;
  /** Verified grant at provisioning time (safe metadata, not the secret). */
  scopes?: unknown[] | null;
}

export type ProvisionOutcome =
  | { ok: true; value: ProvisionedServiceIdentity }
  | {
      ok: false;
      /** Stable machine-readable reason. `bootstrap_grant_insufficient` =
       *  the bootstrap credential cannot create a service identity (SI-D1's
       *  guided-paste fallback branch); `provider_error` = transport/API. */
      reason: "not_implemented" | "bootstrap_grant_insufficient" | "provider_error";
      detail?: string;
    };

/**
 * Service-identity lifecycle (SI2+): OAuth establishes trust once, then the
 * adapter provisions a provider-owned identity the platform operates with.
 * The BOOTSTRAP credential (an OAuth access token, a management session) is
 * handed in per call and must never be persisted by the adapter; the caller
 * deletes identity-class custody once provisioning succeeds.
 */
export interface ProvisionCapability {
  /** Create the provider-side service identity from a bootstrap credential. */
  provisionServiceIdentity(input: {
    /** Decrypted bootstrap credential (identity-class). Never logged. */
    bootstrapCredential: string;
    /** Provider-side anchor (e.g. Cloudflare account external id). */
    externalRef: string | null;
    /** Provider-side display name, `orun/{org}/service`. */
    identityRef: string;
    nowMs: number;
  }): Promise<ProvisionOutcome>;
  /** Scheduled re-issue of the identity's secret material — no human.
   *  `providerRef` is the identity's own provider-side id (from facts). */
  rotateServiceIdentity(input: {
    current: ParentCredentialContext;
    providerRef: string;
    nowMs: number;
  }): Promise<ProvisionOutcome>;
  /** Best-effort provider-side delete on connection revoke — killing the
   *  identity also kills every outstanding child minted from it. */
  revokeServiceIdentity(
    current: ParentCredentialContext,
    providerRef: string,
    nowMs: number,
  ): Promise<boolean>;
}

/** Channel discovery for the messaging archetype (IH2). Message DELIVERY is
 *  deliberately NOT here — it stays behind the ES ChannelProvider seam in
 *  notifications-worker (design §4.2, the custody/delivery split). The
 *  adapter is per-environment; the per-connection bot token is decrypted by
 *  the caller from custody and handed in per call, never held. */
export interface MessagingCapability {
  listChannels(input: {
    accessToken: string;
    query?: string;
    cursor?: string;
  }): Promise<{ channels: Array<{ externalId: string; name: string; isPrivate: boolean }>; nextCursor: string | null } | null>;
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
  /** Secret-source DESCRIBE capability (saas-secrets-platform SP0). Present iff
   *  `capabilities` includes "secrets"; a provider that declares it MUST also
   *  declare `broker`. Lets the secrets substrate derive templates/modes/targets
   *  instead of hardcoding them. */
  secrets?: SecretsCapability;
  /** Service-identity lifecycle (SI2+); dormant until an adapter implements
   *  it. Not surfaced in `capabilities` until it goes live per provider. */
  provision?: ProvisionCapability;

  // ── Connect (IG1) — install-kind legacy surface ───────────
  // These remain the live GitHub connect path; the token connect kind lands
  // with its milestone (IH5 Cloudflare).
  buildInstallUrl?(input: BuildInstallUrlInput): string;
  /**
   * Fetch + verify installation facts as the App. Returning null means the
   * installation could not be verified — callers fail closed.
   */
  completeConnect?(input: CompleteConnectInput): Promise<ProviderConnectionFacts | null>;
  /** Best-effort provider-side uninstall on platform revoke. */
  revokeInstallation?(installationId: number, nowMs: number): Promise<boolean>;

  // ── Connect (IH1) — oauth-kind surface ────────────────────
  /** The provider's OAuth authorize URL carrying our signed state. */
  buildAuthorizeUrl?(input: BuildAuthorizeUrlInput): string;
  /**
   * Exchange the callback's authorization code for a verified grant.
   * Returning null means the provider refused the code — callers fail closed.
   */
  exchangeOauthCode?(input: ExchangeOauthCodeInput): Promise<ProviderOauthGrant | null>;
  /** Best-effort provider-side token revocation on platform revoke. */
  revokeOauthToken?(accessToken: string, nowMs: number): Promise<boolean>;

  // ── Inbound (IG2) — legacy single-header alias ────────────
  /** @deprecated Delegates to `inbound.verifySignature`; kept so shipped
   *  GitHub handlers/tests pass unchanged during the IH0 re-expression. */
  verifyInboundSignature?(rawBody: ArrayBuffer, signatureHeader: string | null): Promise<boolean>;
}

/** Narrow an adapter to a capability, or null (typed 4xx at the handler). */
export function getCapability<K extends "inbound" | "broker" | "messaging" | "provision">(
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

/** Cloudflare OAuth client per-environment credentials (IH risks D3). Present
 *  only when the environment has registered an OAuth client; without it the
 *  Cloudflare adapter falls back to the token-paste connect posture. */
export interface CloudflareOauthCredentials {
  clientId: string;
  clientSecret: string;
  /** Whitespace-separated OAuth scope list to request at consent. Cloudflare
   *  requires an explicit scope (no default) and only returns a refresh token
   *  when `offline_access` is present — the adapter always ensures it is. The
   *  requested scopes must be a subset of what the client was registered with.
   *  Sourced from `CLOUDFLARE_OAUTH_SCOPE` (escrow config); unset → the adapter
   *  requests its minimal mint-only default. */
  scope?: string;
}
