/**
 * Secret event-type constants (saas-secret-manager). The write path emits
 * `secrets.updated`; SM3 adds the resolve-time provenance events. Audit rows
 * and event payloads are key-name-only — a secret value NEVER enters an event
 * (orun-secrets Invariant; policy-model §8).
 */
export const SECRET_EVENT_TYPES = {
  /** Write path: create / rotate / revoke / import (shipped). */
  UPDATED: "secrets.updated",
  /** SM3 resolve: a value was served for a key (payload = key/version/scope/decisionId). */
  ACCESSED: "secret.accessed",
  /** SM3 resolve: a key was denied (payload = key + stable reason code + decisionId). */
  DENIED: "secret.denied",
  /** SM3 policy push: a SecretPolicy document was upserted. */
  POLICY_UPDATED: "secret.policy.updated",
} as const;

export type SecretEventType = (typeof SECRET_EVENT_TYPES)[keyof typeof SECRET_EVENT_TYPES];
