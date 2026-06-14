import { hexToUuid, uuidToHex, uuidFromPublicId, type Uuid } from "@saas/db/ids";

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `req_${hex}`;
}

/** RFC-4122 v4 UUID for new rows and event ids. */
export function generateUuid(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  buf[6] = (buf[6]! & 0x0f) | 0x40;
  buf[8] = (buf[8]! & 0x3f) | 0x80;
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseOrgPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "org");
}

export function parseProjectPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "prj");
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function projectPublicId(uuid: string): string {
  return `prj_${uuidToHex(uuid)}`;
}

// ── Runs ────────────────────────────────────────────────────
// A run's public id is a display alias over the client-minted ULID — NOT a
// UUID-hex public id. The ULID is the wire identity (`runId` in the contract);
// the `run_` prefix is purely a console/CLI display convenience. We never
// decode it back into a UUID (the run's row UUID is internal).

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Validate a client-supplied ULID (Crockford base32, 26 chars). */
export function isRunUlid(value: string): boolean {
  return ULID_RE.test(value);
}

/** Display alias for a run: `run_<ULID>`. Pure presentation, never decoded. */
export function runDisplayId(runUlid: string): string {
  return `run_${runUlid}`;
}

/** Extract the ULID from a `run_<ULID>` display id, or null if malformed. */
export function parseRunDisplayId(displayId: string): string | null {
  if (!displayId.startsWith("run_")) return null;
  const ulid = displayId.slice(4);
  return isRunUlid(ulid) ? ulid : null;
}

// ── Workspace links ─────────────────────────────────────────
// UUID-hex public id, mirroring integrations' `repl_` repo-link ids.

export function workspaceLinkPublicId(uuid: string): string {
  return `wsl_${uuidToHex(uuid)}`;
}

export function parseWorkspaceLinkPublicId(publicId: string): string | null {
  if (!publicId.startsWith("wsl_")) return null;
  return hexToUuid(publicId.slice(4));
}
