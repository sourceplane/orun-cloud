/**
 * Pure logic for the "Mint credential" dialog and the mint ledger
 * (saas-integration-hub IH8, design §6 "the mint ledger").
 *
 * Dependency-free (no React, no `next/*`, no DOM) so the reveal-once
 * invariants are unit-testable in isolation (tests/web-console-next). The
 * React wiring lives in `mint-ledger.tsx`; this file owns:
 *
 *   - the dialog's state machine (`MintState`, `nextMintState`)
 *   - form validation (`validateMintForm`: declared params + TTL bounds)
 *   - error typing (`classifyMintError`: 412 entitlement vs inline message)
 *   - ledger view helpers (`mintStatusView`, `mintPurposeView`, `formatRelative`)
 *
 * THE REVEAL-ONCE RULE is enforced at the state-machine level: the
 * `credential` map only ever exists on the `revealed` state, and every
 * `close` transition returns to `pick` (no credential field at all) — so
 * closing the dialog cannot leave the minted value behind in state. The
 * credential is never toasted and never logged.
 */

/**
 * Structural twin of `ScopeTemplateInfo` (archetype.ts) — declared locally so
 * this pure module (and its tests) never depend on the catalog module.
 */
export interface MintTemplateLike {
  id: string;
  displayName: string;
  params: readonly string[];
  maxTtlSeconds: number;
}

/** Design §5.1: default 15 min. */
export const DEFAULT_MINT_TTL_SECONDS = 900;
/** Console-side floor — a sub-minute credential is a footgun, not a feature. */
export const MIN_MINT_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// Typed mint errors
// ---------------------------------------------------------------------------

/** Structural subset of `ApiErrorBody` (lib/api.ts) — kept local for purity. */
export interface MintApiError {
  code: string;
  message: string;
  reason?: string | undefined;
  details?: Record<string, unknown> | undefined;
  requestId?: string | undefined;
}

/** The four entitlement-seam reasons `PreconditionInsight` knows how to render. */
const ENTITLEMENT_REASONS = new Set([
  "limit_reached",
  "disabled",
  "not_configured",
  "malformed_limit",
]);

export type MintErrorReason =
  /** 412 with an entitlement-shaped reason — render `PreconditionInsight`. */
  | { kind: "entitlement"; error: MintApiError }
  /** Everything else — typed inline message (412 parent_grant_insufficient, 4xx/5xx, network). */
  | { kind: "message"; message: string; requestId: string | null };

/**
 * Type a failed mint. 412s whose `reason` is one of the entitlement seam's
 * four codes get the upgrade card; every other failure (including
 * 412 `parent_grant_insufficient` / missing-parent shapes) renders as an
 * inline message carrying the requestId when present.
 */
export function classifyMintError(status: number, error: MintApiError): MintErrorReason {
  if (status === 412 && error.reason !== undefined && ENTITLEMENT_REASONS.has(error.reason)) {
    return { kind: "entitlement", error };
  }
  return { kind: "message", message: error.message, requestId: error.requestId ?? null };
}

// ---------------------------------------------------------------------------
// The dialog state machine: pick → confirm → minting → revealed | error
// ---------------------------------------------------------------------------

export type MintState =
  | { phase: "pick" }
  | { phase: "confirm"; templateId: string; params: Record<string, string>; ttlSeconds: number }
  | { phase: "minting"; templateId: string; params: Record<string, string>; ttlSeconds: number }
  | { phase: "revealed"; credential: Record<string, string>; mintId: string; expiresAt: string }
  | { phase: "error"; reason: MintErrorReason };

export type MintEvent =
  /** A VALIDATED form submission (run `validateMintForm` first). */
  | { type: "review"; templateId: string; params: Record<string, string>; ttlSeconds: number }
  /** confirm | error → pick, keeping the dialog open. */
  | { type: "back" }
  | { type: "confirmMint" }
  | { type: "mintSucceeded"; credential: Record<string, string>; mintId: string; expiresAt: string }
  | { type: "mintFailed"; reason: MintErrorReason }
  /** ALWAYS resets to pick, dropping any revealed credential. */
  | { type: "close" };

/**
 * Drive the mint flow forward.
 *
 * Invariants:
 *   - `confirmMint` is only honored from `confirm` (no accidental mint).
 *   - `mintSucceeded`/`mintFailed` are only honored from `minting`.
 *   - `close` ALWAYS returns `{ phase: "pick" }` — the credential cannot
 *     survive a close. Callers must discard the previous state object.
 */
export function nextMintState(state: MintState, event: MintEvent): MintState {
  if (event.type === "close") return { phase: "pick" };
  switch (state.phase) {
    case "pick":
      if (event.type === "review") {
        return {
          phase: "confirm",
          templateId: event.templateId,
          params: event.params,
          ttlSeconds: event.ttlSeconds,
        };
      }
      return state;
    case "confirm":
      if (event.type === "back") return { phase: "pick" };
      if (event.type === "confirmMint") {
        return {
          phase: "minting",
          templateId: state.templateId,
          params: state.params,
          ttlSeconds: state.ttlSeconds,
        };
      }
      return state;
    case "minting":
      if (event.type === "mintSucceeded") {
        return {
          phase: "revealed",
          credential: event.credential,
          mintId: event.mintId,
          expiresAt: event.expiresAt,
        };
      }
      if (event.type === "mintFailed") return { phase: "error", reason: event.reason };
      return state;
    case "revealed":
      // Only `close` (handled above) leaves the reveal pane — one exit, which drops the value.
      return state;
    case "error":
      if (event.type === "back") return { phase: "pick" };
      return state;
  }
}

// ---------------------------------------------------------------------------
// Form validation
// ---------------------------------------------------------------------------

export type MintFormResult =
  | { ok: true; params: Record<string, string>; ttlSeconds: number }
  | { ok: false; errors: Record<string, string> };

/**
 * Validate the mint form against a template's declared shape.
 *
 *   - every declared param is required non-empty (trimmed);
 *   - `ttlInput` empty → default 900s clamped to the template max;
 *   - otherwise the TTL must be an integer within
 *     [MIN_MINT_TTL_SECONDS, template.maxTtlSeconds].
 *
 * Errors are keyed by param name, plus `"ttl"` for the TTL field. Only the
 * template's declared params make it into the ok result — stray inputs from a
 * previously selected template are dropped.
 */
export function validateMintForm(
  template: MintTemplateLike,
  paramInputs: Record<string, string>,
  ttlInput: string,
): MintFormResult {
  const errors: Record<string, string> = {};
  const params: Record<string, string> = {};

  for (const name of template.params) {
    const value = (paramInputs[name] ?? "").trim();
    if (value.length === 0) {
      errors[name] = "Required";
    } else {
      params[name] = value;
    }
  }

  let ttlSeconds = Math.min(DEFAULT_MINT_TTL_SECONDS, template.maxTtlSeconds);
  const rawTtl = ttlInput.trim();
  if (rawTtl.length > 0) {
    const n = Number(rawTtl);
    if (!Number.isInteger(n)) {
      errors.ttl = "Whole number of seconds";
    } else if (n < MIN_MINT_TTL_SECONDS || n > template.maxTtlSeconds) {
      errors.ttl = `Between ${MIN_MINT_TTL_SECONDS} and ${template.maxTtlSeconds} seconds`;
    } else {
      ttlSeconds = n;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, params, ttlSeconds };
}

// ---------------------------------------------------------------------------
// Ledger view helpers
// ---------------------------------------------------------------------------

/** Northwind pill tone (kept as a bare string — no UI import). */
export type PillTone = "success" | "warning" | "error" | "info" | "neutral";

export interface MintStatusView {
  label: string;
  tone: PillTone;
}

/**
 * Map a ledger row's revoke status (+ expiry vs `now`) to a pill. A `pending`
 * row past its expiry renders as expired even before the sweep flips the
 * ledger — the TTL is the backstop, and the console says so honestly.
 */
export function mintStatusView(
  mint: { revokeStatus: string; expiresAt: string },
  now: Date,
): MintStatusView {
  switch (mint.revokeStatus) {
    case "pending": {
      const exp = new Date(mint.expiresAt).getTime();
      if (!Number.isNaN(exp) && exp <= now.getTime()) return { label: "Expired", tone: "neutral" };
      return { label: "Active", tone: "success" };
    }
    case "revoked":
      return { label: "Revoked", tone: "neutral" };
    case "expired":
      return { label: "Expired", tone: "neutral" };
    case "orphaned":
      return { label: "Orphaned", tone: "warning" };
    default:
      return { label: mint.revokeStatus, tone: "neutral" };
  }
}

export interface MintPurposeView {
  label: string;
  /** Badge variant string (matches `@/components/ui/badge`). */
  variant: "info" | "secondary";
}

/** Purpose badge: operator-initiated API mints vs run-time secret resolves. */
export function mintPurposeView(purpose: string): MintPurposeView {
  return purpose === "secret_resolve"
    ? { label: "Secret resolve", variant: "secondary" }
    : { label: "API", variant: "info" };
}

/**
 * Compact relative timestamp for the ledger's minted→expires window:
 * "12s ago" / "5m ago" / "in 10m" / "in 2h" / "3d ago". Invalid input → "—".
 */
export function formatRelative(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const deltaMs = t - now.getTime();
  const past = deltaMs < 0;
  const abs = Math.abs(deltaMs);
  const s = Math.round(abs / 1000);
  let span: string;
  if (s < 60) span = `${s}s`;
  else if (s < 3600) span = `${Math.round(s / 60)}m`;
  else if (s < 86400) span = `${Math.round(s / 3600)}h`;
  else span = `${Math.round(s / 86400)}d`;
  return past ? `${span} ago` : `in ${span}`;
}
