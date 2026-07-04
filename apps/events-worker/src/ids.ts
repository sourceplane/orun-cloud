import { hexToUuid, uuidToHex } from "@saas/db/ids";


function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export function generateRequestId(): string {
  return `req_${randomHex(12)}`;
}

/** Dead-letter public id (dl_<32hex>) — the TEXT PK, no uuid conversion. */
export function generateDeadLetterId(): string {
  return `dl_${randomHex(16)}`;
}

/** Opaque event/audit row id, matching the platform's evt_<hex> convention. */
export function generateEventId(): string {
  return `evt_${randomHex(16)}`;
}

const DEAD_LETTER_ID_RE = /^dl_[0-9a-f]{32}$/;

export function isDeadLetterId(id: string): boolean {
  return DEAD_LETTER_ID_RE.test(id);
}

export function parseOrgPublicId(publicId: string): string | null {
  if (!publicId.startsWith("org_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function projectPublicId(uuid: string): string {
  return `prj_${uuidToHex(uuid)}`;
}

export function environmentPublicId(uuid: string): string {
  return `env_${uuidToHex(uuid)}`;
}

export function invitationPublicId(uuid: string): string {
  return `inv_${uuidToHex(uuid)}`;
}

export function memberPublicId(uuid: string): string {
  return `mem_${uuidToHex(uuid)}`;
}

const SUBJECT_KIND_PREFIX: Record<string, (uuid: string) => string> = {
  organization: orgPublicId,
  project: projectPublicId,
  environment: environmentPublicId,
  invitation: invitationPublicId,
  member: memberPublicId,
};

export function toPublicId(kind: string, rawId: string): string {
  const fn = SUBJECT_KIND_PREFIX[kind];
  if (fn) return fn(rawId);
  return rawId;
}

export function toPublicScopeId(prefix: string, rawId: string | null): string | null {
  if (!rawId) return null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(rawId)) return rawId;
  return `${prefix}${uuidToHex(rawId)}`;
}
