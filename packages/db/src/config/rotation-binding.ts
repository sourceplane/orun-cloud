// Provider-rotation producer binding validation (provider-rotated-secrets RS0).
//
// A provider-rotated secret is an ordinary `source = 'static'` stored secret
// whose next value is minted by the integrations credential broker on the SM6
// rotation schedule (the RS2 engine). This module is the pure validator for the
// producer binding — no DB, no I/O — so the create/update handlers (RS1) and
// the migration guard agree on one shape. The DB CHECKs in 870 are the
// last-line guard; this is the first-line, human-readable one.

/**
 * Integration providers whose credential broker can produce a rotated value.
 * v1 ships Cloudflare (the IH5 adapter, `mintCloudflareToken`). Widen as
 * broker adapters land (Supabase IH6, AWS STS IH10).
 */
export const ALLOWED_ROTATION_PROVIDERS = ["cloudflare"] as const;

export type RotationProvider = (typeof ALLOWED_ROTATION_PROVIDERS)[number];

/**
 * The producer half of a provider-rotated secret: how to mint the next value
 * (provider + connection + template + params), an optional grace overlap, and
 * an optional delivery target for consumers that HOLD the value. The WHEN of
 * rotation stays on the shipped SM6 columns (rotationPolicy/expiresAt); this is
 * only the WHAT/HOW.
 */
export interface RotationProducer {
  provider: RotationProvider;
  connectionId: string;
  template: string;
  params?: Record<string, unknown>;
  graceSeconds?: number;
  deliverTarget?: string;
}

export type ValidateRotationProducerResult =
  | { ok: true; value: RotationProducer }
  | { ok: false; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a rotation-producer binding, fail-closed with a specific reason.
 * Mirrors the 870 migration guards: the producer core (provider, connectionId,
 * template) is required and coherent; params/graceSeconds/deliverTarget are
 * optional adjuncts. Returns a normalized RotationProducer on success.
 */
export function validateRotationProducer(input: unknown): ValidateRotationProducerResult {
  if (input === null || typeof input !== "object") {
    return { ok: false, reason: "rotation producer must be an object" };
  }
  const raw = input as Record<string, unknown>;

  const provider = raw.provider;
  if (typeof provider !== "string" || !ALLOWED_ROTATION_PROVIDERS.includes(provider as RotationProvider)) {
    return {
      ok: false,
      reason: `provider must be one of ${ALLOWED_ROTATION_PROVIDERS.join(", ")}`,
    };
  }

  const connectionId = raw.connectionId;
  if (typeof connectionId !== "string" || !UUID_RE.test(connectionId)) {
    return { ok: false, reason: "connectionId must be a uuid" };
  }

  const template = raw.template;
  if (typeof template !== "string" || template.trim() === "") {
    return { ok: false, reason: "template must be a non-empty string" };
  }

  const out: RotationProducer = {
    provider: provider as RotationProvider,
    connectionId,
    template,
  };

  if (raw.params !== undefined && raw.params !== null) {
    if (typeof raw.params !== "object" || Array.isArray(raw.params)) {
      return { ok: false, reason: "params must be an object" };
    }
    out.params = raw.params as Record<string, unknown>;
  }

  if (raw.graceSeconds !== undefined && raw.graceSeconds !== null) {
    const g = raw.graceSeconds;
    if (typeof g !== "number" || !Number.isInteger(g) || g < 0) {
      return { ok: false, reason: "graceSeconds must be a non-negative integer" };
    }
    out.graceSeconds = g;
  }

  if (raw.deliverTarget !== undefined && raw.deliverTarget !== null) {
    if (typeof raw.deliverTarget !== "string" || raw.deliverTarget.trim() === "") {
      return { ok: false, reason: "deliverTarget must be a non-empty string when set" };
    }
    out.deliverTarget = raw.deliverTarget;
  }

  return { ok: true, value: out };
}
