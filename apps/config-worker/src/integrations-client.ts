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
const CONNECTION_STATUS_URL = "https://integrations.internal/internal/connections/status";
const ROTATE_SOURCE_URL = "https://integrations.internal/internal/credentials/rotate-source";

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
  | { ok: true; provider: string; maxTtlSeconds: number; supportedModes: readonly ("brokered" | "rotated")[] }
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
  // supportedModes (SP0b) is tolerated absent for back-compat with an older
  // integrations-worker (treated as unknown ⇒ the gate does not over-reject).
  const supportedModes = Array.isArray(data.supportedModes)
    ? (data.supportedModes as ("brokered" | "rotated")[])
    : [];
  return { ok: true, provider: data.provider, maxTtlSeconds: data.maxTtlSeconds, supportedModes };
}

export type ConnectionStatusesResult =
  | { ok: true; statuses: Record<string, string> }
  | { ok: false };

/**
 * POST /internal/connections/status — batch connection health for orphan
 * stamping (brokered-orphan-safety, Feature 1). Fail-soft: any network/parse
 * error or non-200 returns `{ ok: false }` so the caller shows "health unknown"
 * rather than asserting orphaned.
 */
export async function fetchConnectionStatuses(
  binding: Fetcher,
  connectionIds: string[],
  requestId: string,
): Promise<ConnectionStatusesResult> {
  if (connectionIds.length === 0) return { ok: true, statuses: {} };
  let response: Response;
  let parsed: unknown;
  try {
    response = await binding.fetch(CONNECTION_STATUS_URL, {
      method: "POST",
      headers: headers(requestId),
      body: JSON.stringify({ connectionIds }),
    });
    parsed = await response.json();
  } catch {
    return { ok: false };
  }
  if (response.status !== 200) return { ok: false };
  const data =
    parsed && typeof parsed === "object" && "data" in parsed
      ? ((parsed as { data: unknown }).data as { statuses?: Record<string, string> } | null)
      : null;
  return { ok: true, statuses: data?.statuses ?? {} };
}

export type RotateSourceResult =
  | { ok: true; rotatedAt: string }
  | { ok: false; status: number; reason: string };

/**
 * POST /internal/credentials/rotate-source — roll the org-owned source
 * credential behind a brokered secret's connection (SC2). Metadata only: the
 * rotated value never crosses back, only the timestamp. Network/parse errors
 * fail closed as `{ ok: false, status: 503, reason: "unavailable" }`.
 */
export async function rotateConnectionSource(
  binding: Fetcher,
  req: { orgId: string; connectionId: string },
  requestId: string,
): Promise<RotateSourceResult> {
  let response: Response;
  let parsed: unknown;
  try {
    response = await binding.fetch(ROTATE_SOURCE_URL, {
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
      ? ((parsed as { data: unknown }).data as { rotatedAt?: unknown } | null)
      : null;
  if (!data || typeof data.rotatedAt !== "string") {
    return { ok: false, status: 503, reason: "unavailable" };
  }
  return { ok: true, rotatedAt: data.rotatedAt };
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
