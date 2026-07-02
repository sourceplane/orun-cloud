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
  /** SM5 materialize: a secret version was synced into a target entity
   *  (payload = key/version/target/entityRef/runId — NEVER a value). */
  SYNC_RECORDED: "secret.sync.recorded",
  /**
   * SEC7 break-glass: an authorized operator revealed a secret's plaintext via
   * the audited reveal endpoint (payload = key/version/reason/decisionId — NEVER
   * the value). This is an ALERT-worthy event: the events envelope carries no
   * severity/alert field (packages/db/src/events/types.ts AppendEventInput), so a
   * DISTINCT event type is the severity signal the notifications layer keys off.
   */
  REVEALED: "secret.revealed",
  /**
   * SEC7 rotation cron: a secret's rotation_policy interval has elapsed since its
   * last rotation (payload = key/scope/rotationPolicy/lastRotatedAt/expiresAt/
   * ageDays — NEVER a value). Alert-worthy via the distinct type.
   */
  ROTATION_DUE: "secret.rotation_due",
  /**
   * SEC7 rotation cron: a secret's expires_at falls within the lead window
   * (payload = key/scope/rotationPolicy/lastRotatedAt/expiresAt/ageDays — NEVER a
   * value). Alert-worthy via the distinct type.
   */
  EXPIRING: "secret.expiring",
} as const;

export type SecretEventType = (typeof SECRET_EVENT_TYPES)[keyof typeof SECRET_EVENT_TYPES];
