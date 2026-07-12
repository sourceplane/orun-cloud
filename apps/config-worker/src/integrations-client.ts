// Brokered-secret client for integrations-worker's internal broker routes
// (saas-integration-hub IH7, design §5.4). Reachable ONLY over the
// INTEGRATIONS_WORKER service binding; both routes are service-binding-only
// and gated on `x-internal-caller: config-worker` (BROKERED_MINT_CALLER).
//
// validate-binding runs at secret CREATE time (the pointer must name a live,
// broker-capable connection + a published template); mint runs at RESOLVE
// time. The minted value is returned to the resolve handler and NEVER logged,
// audited, or rethrown — custody of provider credentials stays with
// integrations-worker; the value only transits this isolate's memory.

import {
  BROKERED_MINT_CALLER,
  type ValidateBrokerBindingRequest,
  type ValidateBrokerBindingResponse,
  type InternalMintCredentialRequest,
  type InternalMintCredentialResponse,
} from "@saas/contracts/integrations";

const VALIDATE_URL = "https://integrations.internal/internal/credentials/validate-binding";
const MINT_URL = "https://integrations.internal/internal/credentials/mint";

function headers(requestId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-internal-caller": BROKERED_MINT_CALLER,
    "x-request-id": requestId,
  };
}

/** Stable machine reason from the standard error envelope's `details.reason`. */
function failureReason(parsed: unknown): string {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const err = (parsed as { error?: { details?: { reason?: unknown } } }).error;
    if (err && typeof err.details?.reason === "string") return err.details.reason;
  }
  return "unavailable";
}

export type BrokerBindingValidation =
  | { ok: true; provider: string; maxTtlSeconds: number }
  | { ok: false; status: number; reason: string };

/**
 * POST /internal/credentials/validate-binding — validate a brokered binding
 * pointer at create time and learn the connection's provider (stored for
 * chain provenance). Network/parse failures fail closed as
 * `{ok:false, status:503, reason:"unavailable"}`.
 */
export async function validateBrokerBinding(
  binding: Fetcher,
  req: ValidateBrokerBindingRequest,
  requestId: string,
): Promise<BrokerBindingValidation> {
  let response: Response;
  let parsed: unknown;
  try {
    response = await binding.fetch(VALIDATE_URL, {
      method: "POST",
      headers: headers(requestId),
      body: JSON.stringify(req),
    });
    parsed = await response.json();
  } catch {
    return { ok: false, status: 503, reason: "unavailable" };
  }
  if (response.status !== 200) {
    return { ok: false, status: response.status, reason: failureReason(parsed) };
  }
  const data =
    parsed && typeof parsed === "object" && "data" in parsed
      ? ((parsed as { data: unknown }).data as Partial<ValidateBrokerBindingResponse> | null)
      : null;
  if (!data || typeof data.provider !== "string" || typeof data.maxTtlSeconds !== "number") {
    return { ok: false, status: 503, reason: "unavailable" };
  }
  return { ok: true, provider: data.provider, maxTtlSeconds: data.maxTtlSeconds };
}

export type BrokeredMintOutcome =
  | { ok: true; value: string; mintId: string; provider: string; template: string; expiresAt: string }
  | { ok: false; status: number; reason: string };

/**
 * POST /internal/credentials/mint — mint the short-lived credential a brokered
 * secret resolves to (`purpose: "secret_resolve"`). The returned `value` is
 * reveal-once: the caller may place it ONLY in the resolve response's secrets
 * map. This function never logs it and never rethrows with it. `mintId` is the
 * ledger join key (`mint_…`) that makes every brokered resolve doubly visible
 * (secret.accessed ↔ broker ledger).
 */
export async function mintBrokeredCredential(
  binding: Fetcher,
  req: InternalMintCredentialRequest,
  requestId: string,
): Promise<BrokeredMintOutcome> {
  let response: Response;
  let parsed: unknown;
  try {
    response = await binding.fetch(MINT_URL, {
      method: "POST",
      headers: headers(requestId),
      body: JSON.stringify(req),
    });
    parsed = await response.json();
  } catch {
    return { ok: false, status: 503, reason: "unavailable" };
  }
  if (response.status !== 201) {
    return { ok: false, status: response.status, reason: failureReason(parsed) };
  }
  const data =
    parsed && typeof parsed === "object" && "data" in parsed
      ? ((parsed as { data: unknown }).data as Partial<InternalMintCredentialResponse> | null)
      : null;
  if (
    !data ||
    typeof data.value !== "string" ||
    !data.mint ||
    typeof data.mint.id !== "string" ||
    typeof data.mint.provider !== "string" ||
    typeof data.mint.template !== "string" ||
    typeof data.mint.expiresAt !== "string"
  ) {
    return { ok: false, status: 503, reason: "unavailable" };
  }
  return {
    ok: true,
    value: data.value,
    mintId: data.mint.id,
    provider: data.mint.provider,
    template: data.mint.template,
    expiresAt: data.mint.expiresAt,
  };
}
