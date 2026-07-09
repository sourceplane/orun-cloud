// Write-tool idempotency (design §7): every write tool auto-generates an
// `Idempotency-Key` per logical attempt and accepts a caller-supplied one, so
// agent retries are replay-safe at the edge (B3) with zero new server code —
// the key rides the SDK's per-request `RequestOptions.idempotencyKey` seam
// (Stripe parity; `packages/sdk/src/transport.ts`).

import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  describeIdempotencyKeyParseError,
  parseIdempotencyKey,
} from "@saas/contracts/idempotency";
import { z } from "zod";

/**
 * Shared zod fragment for the optional caller-supplied `idempotencyKey` input
 * on every write tool. Validated with the platform contract parser (1..255
 * printable-ASCII chars) so a bad key fails locally instead of at the edge.
 */
export const idempotencyKeyArg = z
  .string()
  .superRefine((value, ctx) => {
    const parsed = parseIdempotencyKey(value);
    if (!parsed.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: describeIdempotencyKeyParseError(parsed.reason),
      });
    }
  })
  .describe(
    "Optional Idempotency-Key for this write (1-255 printable ASCII chars). Omit it and the tool generates a fresh key per call; supply the SAME key when retrying a call whose outcome you did not observe, so the platform replays the original result instead of double-creating.",
  );

/**
 * The key that actually rides the request: the caller's key when supplied
 * (trimmed, contract-validated by `idempotencyKeyArg`), otherwise a fresh
 * `mcp_<uuid>` per logical attempt.
 */
export function resolveIdempotencyKey(supplied: string | undefined): string {
  if (supplied !== undefined) {
    const parsed = parseIdempotencyKey(supplied);
    if (parsed.ok && parsed.key !== null) return parsed.key;
    // Unreachable behind `idempotencyKeyArg`, but never send a malformed key.
  }
  return `mcp_${crypto.randomUUID()}`;
}

/**
 * Derive a related key for a secondary mutation inside one tool call (e.g.
 * the subscriptions `webhook_create` fans out to after the endpoint create).
 * Deterministic for the same base key — a retried call re-derives the same
 * keys — and always within the 255-char contract cap.
 */
export function deriveIdempotencyKey(base: string, suffix: string): string {
  return `${base.slice(0, IDEMPOTENCY_KEY_MAX_LENGTH - suffix.length)}${suffix}`;
}
