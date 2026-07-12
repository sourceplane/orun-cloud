/**
 * Pure state machine for the token-paste connect flow (IH8, Cloudflare).
 *
 * Kept dependency-free (no React, no `next/*`, no DOM) so the flow's
 * invariants can be unit-tested in isolation — mirror of
 * `src/components/webhooks/rotate-flow.ts`. The React wiring lives in
 * `cloudflare-connect-modal.tsx`; this file owns:
 *
 *   - the state machine (`TokenConnectState`, `nextTokenConnectState`)
 *   - the client-side token-format precheck
 *   - the API-failure → typed-error classifier
 *
 * Custody invariant, enforced at the state-machine level: NO state ever
 * carries the pasted token. The `submit` event carries it transiently for the
 * format precheck only; verification-before-save is server-side (the worker
 * calls Cloudflare's `/user/tokens/verify` before any write).
 */

/**
 * Client-side precheck, mirroring PARENT_TOKEN_RE in
 * `apps/integrations-worker/src/handlers/cloudflare-connect.ts`: Cloudflare
 * API tokens are ~40 url-safe chars; accept a generous band without ever
 * echoing the value back.
 */
export const CLOUDFLARE_PARENT_TOKEN_RE = /^[A-Za-z0-9._-]{20,256}$/;

export function isValidParentTokenFormat(token: string): boolean {
  return CLOUDFLARE_PARENT_TOKEN_RE.test(token.trim());
}

export type TokenConnectErrorKind =
  | "invalid_format"
  | "verify_failed"
  | "parent_grant"
  | "entitlement"
  | "unavailable";

export type TokenConnectState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "error"; kind: TokenConnectErrorKind; message: string; requestId: string | null }
  | { phase: "connected" };

export type TokenConnectEvent =
  /** The user submitted the paste; `token` is checked, never stored. */
  | { type: "submit"; token: string }
  | { type: "succeeded" }
  | {
      type: "failed";
      kind: Exclude<TokenConnectErrorKind, "invalid_format">;
      message: string;
      requestId: string | null;
    }
  /** Close/unmount: always returns to `idle`, dropping everything. */
  | { type: "reset" };

/**
 * Classify a failed connect call into a typed error kind, from the worker's
 * bounded 412 reasons (`cloudflare-connect.ts` + the shared connect gate in
 * `connections.ts`):
 *
 *   - `token_verification_failed`      → verify_failed (the paste is not a
 *                                        live token — re-paste)
 *   - `no_account_visible`             → parent_grant (live token, but it
 *                                        cannot see an account — rescope it)
 *   - entitlement-seam reasons
 *     (`limit_reached`/`disabled`/`malformed_limit`, or `not_configured`
 *     carrying `entitlementKey`)       → entitlement (surface via the hub's
 *                                        PreconditionInsight, not the modal)
 *   - everything else (custody gate `not_configured`, 409 conflict, 5xx,
 *     network)                         → unavailable
 */
export function classifyTokenConnectFailure(
  status: number,
  error: { reason?: string | undefined; details?: Record<string, unknown> | undefined },
): Exclude<TokenConnectErrorKind, "invalid_format"> {
  const reason = error.reason ?? null;
  if (status === 412) {
    if (reason === "token_verification_failed") return "verify_failed";
    if (reason === "no_account_visible") return "parent_grant";
    if (reason === "limit_reached" || reason === "disabled" || reason === "malformed_limit") {
      return "entitlement";
    }
    if (reason === "not_configured") {
      // `not_configured` is overloaded: the entitlement seam tags it with the
      // entitlement key; the custody/registration gate tags it with `gate`.
      return typeof error.details?.entitlementKey === "string" ? "entitlement" : "unavailable";
    }
  }
  return "unavailable";
}

/**
 * Drive the token-connect flow forward.
 *
 * Invariants:
 *   - `submit` is only honored from `idle`/`error` (no double submit while a
 *     call is in flight).
 *   - A paste failing the format precheck short-circuits to
 *     `error(invalid_format)` without any API call.
 *   - `reset` ALWAYS returns `idle` from any phase — and because `idle`
 *     ignores `failed`/`succeeded`, a late API result after close is a no-op.
 *   - No state carries the token.
 */
export function nextTokenConnectState(
  state: TokenConnectState,
  event: TokenConnectEvent,
): TokenConnectState {
  if (event.type === "reset") return { phase: "idle" };
  switch (state.phase) {
    case "idle":
    case "error":
      if (event.type === "submit") {
        return isValidParentTokenFormat(event.token)
          ? { phase: "submitting" }
          : {
              phase: "error",
              kind: "invalid_format",
              message: "That doesn't look like a Cloudflare API token — check the paste and try again.",
              requestId: null,
            };
      }
      return state;
    case "submitting":
      if (event.type === "succeeded") return { phase: "connected" };
      if (event.type === "failed") {
        return {
          phase: "error",
          kind: event.kind,
          message: event.message,
          requestId: event.requestId,
        };
      }
      return state;
    case "connected":
      return state;
  }
}
