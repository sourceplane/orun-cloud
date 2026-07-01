// Branded UUID identifier shared by all repository inputs.
//
// Public ids cross the API boundary as `<prefix>_<32 hex>` (a UUID with dashes
// stripped); most DB columns store a bare UUID. Both are `string`, so passing
// the public form into a UUID column compiles but fails at runtime
// (`invalid input syntax for type uuid`). `Uuid` is a nominal/branded string:
// repository inputs bound to UUID columns are typed `Uuid`, so a caller can only
// satisfy them by going through `uuidFromPublicId` / `asUuid`, which makes a
// missing decode a *compile error* rather than a runtime crash.

declare const uuidBrand: unique symbol;
export type Uuid = string & { readonly [uuidBrand]: true };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/i;

/** Type guard: true when `value` is a canonical UUID. */
export function isUuid(value: string): value is Uuid {
  return UUID_RE.test(value);
}

/** Assert that a string is a UUID and brand it. Throws on a non-UUID. */
export function asUuid(value: string): Uuid {
  if (!UUID_RE.test(value)) throw new Error("asUuid: value is not a canonical UUID");
  return value as Uuid;
}

/**
 * Decode a public id of the form `<prefix>_<32 hex>` (e.g. `org_7c82…`,
 * `usr_…`) into a branded `Uuid`. Returns null if the prefix or hex body is
 * malformed. Pass the expected prefix to enforce the id kind, or omit it to
 * accept any `<prefix>_<32 hex>` (handy for actor ids that may be `usr_`/`sp_`).
 */
export function uuidFromPublicId(publicId: string, prefix?: string): Uuid | null {
  const sep = publicId.indexOf("_");
  if (sep < 1) return null;
  if (prefix !== undefined && publicId.slice(0, sep) !== prefix) return null;
  return hexToUuid(publicId.slice(sep + 1)) as Uuid | null;
}

// ── Public-id ⇄ UUID conversion primitives ──────────────────
// Shared so the 10 workers stop each carrying an identical private copy.

/** Strip the dashes from a UUID to form the hex body of a public id. */
export function uuidToHex(uuid: string): string {
  return uuid.replace(/-/g, "");
}

/** Re-insert dashes into a 32-char hex body; null if not 32 hex chars. */
export function hexToUuid(hex: string): string | null {
  if (!HEX32_RE.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── Workspace ID (`ws_…`) codec — saas-workspace-id (WID2) ──
// The durable, immutable, public Workspace ID: `ws_` + 8 Crockford-base32 chars
// (uppercase, excluding I/L/O/U to dodge transcription ambiguity). Minted once at
// org creation and never reissued, so it is safe to commit, quote, and paste —
// unlike the mutable `slug`. Shared here so every worker uses one implementation.

/** Crockford base32 alphabet (uppercase, excludes I, L, O, U). */
const WORKSPACE_REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Matches a well-formed Workspace ID: `ws_` + 8 Crockford-base32 chars. */
const WORKSPACE_REF_RE = /^ws_[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * Generate a Workspace ID: `ws_` + 8 Crockford-base32 chars, drawn from
 * `crypto.getRandomValues` (available in Workers and Node). Rejection sampling
 * trims each random byte to 0–31 before indexing the 32-char alphabet, so there
 * is no modulo bias.
 */
export function generateWorkspaceRef(): string {
  let body = "";
  while (body.length < 8) {
    const buf = new Uint8Array(8 - body.length);
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      // 0..255 → keep only 0..255 that map cleanly; 8 highest values (248..255)
      // would bias toward 0..7, so discard them and resample.
      if (byte >= 248) continue;
      body += WORKSPACE_REF_ALPHABET[byte % 32];
      if (body.length === 8) break;
    }
  }
  return `ws_${body}`;
}

/** Type guard: true when `value` is a well-formed Workspace ID (`ws_…`). */
export function isWorkspaceRef(value: string): boolean {
  return WORKSPACE_REF_RE.test(value);
}

// ── Team ID (`team_…`) codec — saas-teams (TM1/TM2) ─────────────────
// A Team's public id: `team_` + the team's UUID with dashes stripped (32 hex),
// exactly like `usr_`/`sp_`/`org_`/`mem_`. This makes it *resolvable* — a grant
// stores `role_assignments.subject_id = 'team_<hex>'` (subject_type='team') and
// the handler decodes it straight back to the team UUID to look the team up, with
// no separate public-id column. (T1 resolved: hex-derived over base32 — teams are
// principals referenced in grants, not support-quoted handles like `ws_`, so
// consistency + one-step resolvability win.) Render with `team_<uuidToHex>` /
// decode with `uuidFromPublicId(id, 'team')`.

/** Matches a well-formed Team ID: `team_` + 32 hex chars (a UUID, dashes stripped). */
const TEAM_ID_RE = /^team_[0-9a-f]{32}$/i;

/** Type guard: true when `value` is a well-formed Team ID (`team_<hex>`). */
export function isTeamId(value: string): boolean {
  return TEAM_ID_RE.test(value);
}
