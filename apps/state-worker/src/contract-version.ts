// Orun-Contract-Version enforcement (state-api-contract §0).
//
// Every run-coordination route checks the client's `Orun-Contract-Version`
// major. The contract froze at OP2 with major 1; an unknown/unsupported major
// is rejected with `409 contract_version_unsupported` plus the supported range
// so version skew fails loud and actionable at the CLI rather than silently
// mis-parsing. A MISSING header is tolerated (treated as the current major) so
// older clients and internal callers are not broken — only an explicit,
// unsupported major is rejected.

import { STATE_CONTRACT_VERSION, STATE_CONTRACT_VERSION_HEADER } from "@saas/contracts/state";
import { errorResponse } from "./http.js";

/** The inclusive range of contract majors this server understands. */
export const SUPPORTED_CONTRACT_MAJOR_MIN = 1;
export const SUPPORTED_CONTRACT_MAJOR_MAX = STATE_CONTRACT_VERSION;

/**
 * Returns a `409 contract_version_unsupported` Response if the request carries
 * an explicit, unsupported `Orun-Contract-Version` major; otherwise null (the
 * caller proceeds). A missing or non-numeric-but-empty header is allowed.
 */
export function enforceContractVersion(request: Request, requestId: string): Response | null {
  const raw = request.headers.get(STATE_CONTRACT_VERSION_HEADER);
  if (raw == null || raw.trim() === "") return null; // tolerate missing.

  // Accept `1` or `1.x`; the MAJOR is what gates compatibility.
  const major = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(major) || major < SUPPORTED_CONTRACT_MAJOR_MIN || major > SUPPORTED_CONTRACT_MAJOR_MAX) {
    return errorResponse(
      "contract_version_unsupported",
      `Unsupported Orun-Contract-Version: ${raw}. Supported majors: ${SUPPORTED_CONTRACT_MAJOR_MIN}-${SUPPORTED_CONTRACT_MAJOR_MAX}.`,
      409,
      requestId,
      {
        requested: raw,
        supported: { min: SUPPORTED_CONTRACT_MAJOR_MIN, max: SUPPORTED_CONTRACT_MAJOR_MAX },
      },
    );
  }
  return null;
}
