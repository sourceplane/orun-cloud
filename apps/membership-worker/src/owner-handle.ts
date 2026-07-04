// teams-ownership TO-B — owner-string grammar. A git-authored `owner:` string is
// either a bare handle (`payments`) or a typed form (`group:payments`,
// `team:payments`, interoperating with Backstage-style catalog-info.yaml). We
// strip a known `group:`/`team:` prefix and trim; matching is case-insensitive
// (the DB index + resolver both key on the lower-cased result). Applied
// symmetrically on BOTH the stored alias (TO1) and the catalog owner string at
// resolution (TO2) so the two always compare on the same normalized value.

const OWNER_PREFIX_RE = /^(?:group|team):/i;

/** Normalize an owner string to its bare handle (prefix-stripped, trimmed). */
export function normalizeOwnerHandle(input: string): string {
  return input.trim().replace(OWNER_PREFIX_RE, "").trim();
}

/** The case-insensitive match key for an owner string. Empty if unusable. */
export function ownerHandleKey(input: string): string {
  return normalizeOwnerHandle(input).toLowerCase();
}
