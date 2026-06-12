"use client";

/**
 * Last-used organization persistence.
 *
 * We remember the org slug the operator was last working in and use it as the
 * default landing target (app root + post-login), so returning users skip the
 * org picker and go straight to where they left off — the pattern used by
 * Vercel/Linear/GitHub for "last active workspace".
 *
 * Storage is client-side localStorage, consistent with how the session token
 * and API target are already persisted (see `session.tsx`). It's a low-
 * sensitivity hint (just a slug); a stale/invalid value self-heals because the
 * org list and `OrgScope` clear it when the slug isn't accessible.
 *
 * Upgrade path: when a per-user preferences API exists, this can be backed by
 * the server instead so the default follows the user across devices/browsers.
 */

import { STORAGE_PREFIX } from "./app-config";

const LAST_ORG_KEY = `${STORAGE_PREFIX}.last-org`;

export function readLastOrgSlug(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_ORG_KEY);
  } catch {
    return null;
  }
}

export function writeLastOrgSlug(slug: string): void {
  if (typeof window === "undefined" || !slug) return;
  try {
    window.localStorage.setItem(LAST_ORG_KEY, slug);
  } catch {
    /* ignore */
  }
}

export function clearLastOrgSlug(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LAST_ORG_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Default destination after auth / at the app root: the last-used org's projects
 * if one is remembered, otherwise the org picker. Pure given a slug so it's
 * trivially testable; callers pass `readLastOrgSlug()`.
 */
export function defaultOrgDestination(lastOrgSlug: string | null): string {
  return lastOrgSlug ? `/orgs/${lastOrgSlug}/projects` : "/orgs";
}

/** Minimal shape of the auth client needed to read the server-side preference. */
interface ProfileReader {
  auth: { getProfile: () => Promise<{ user: { lastOrgSlug?: string | null } }> };
}

/**
 * Resolve where to send the user right after authentication.
 *
 * The server preference is the cross-device source of truth: we read it with the
 * freshly-authenticated client, seed the local cache from it, and route there.
 * If the read fails (network, API-key token, no server value) we fall back to
 * the local cache so the redirect is never blocked. Pass a client built with the
 * NEW token — the session context's client may not have it yet on this tick.
 */
export async function resolvePostAuthDestination(client: ProfileReader): Promise<string> {
  try {
    const { user } = await client.auth.getProfile();
    const serverSlug = user.lastOrgSlug ?? null;
    if (serverSlug) {
      writeLastOrgSlug(serverSlug);
      return defaultOrgDestination(serverSlug);
    }
  } catch {
    /* fall back to the local cache */
  }
  return defaultOrgDestination(readLastOrgSlug());
}
