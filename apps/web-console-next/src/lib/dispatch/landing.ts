// The workspace landing preference (saas-dispatch DX3).
//
// Design amendment (recorded in IMPLEMENTATION-STATUS, supersedes the spec's
// `feature.dispatch_home` server flag): the landing decision must be
// SYNCHRONOUS — the front door cannot block on a config-worker read without
// violating the epic's own snapshot-first budget (design §4, DD6) — and the
// console has no server-flag evaluation plumbing to ride. So the landing is
// a per-browser, per-workspace preference with **dispatch as the default**;
// Overview stays one click away and offers to reclaim the landing. A
// workspace-level ops kill-switch can ride the config surface later without
// changing this seam.

export type Landing = "dispatch" | "overview";

const KEY_PREFIX = "sp.landing.";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function landingKey(orgSlug: string): string {
  return `${KEY_PREFIX}${orgSlug}`;
}

/** Read the landing for a workspace; anything unknown = the default (dispatch). */
export function readLanding(store: StorageLike | null, orgSlug: string): Landing {
  try {
    const raw = store?.getItem(landingKey(orgSlug));
    return raw === "overview" ? "overview" : "dispatch";
  } catch {
    return "dispatch";
  }
}

export function writeLanding(store: StorageLike | null, orgSlug: string, landing: Landing): void {
  try {
    store?.setItem(landingKey(orgSlug), landing);
  } catch {
    // Preference-only: storage denial degrades to the default, never throws.
  }
}
