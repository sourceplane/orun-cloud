"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { qk } from "@/lib/query";
import { readLastOrgSlug, writeLastOrgSlug } from "@/lib/last-org";
import type { AuthUser } from "@saas/contracts/auth";

/** How long an org must stay current before the server write fires (IC2:
 *  the preference PATCH is best-effort metadata — it has no business on the
 *  boot-critical network window, and a quick pass-through org shouldn't
 *  churn the server preference at all). */
const RECORD_DEBOUNCE_MS = 2_000;

/**
 * Invisible recorder/sync for the last-used org. Mounted once in the app shell.
 *
 * - Records the current org slug to the local cache (instant) and to the server
 *   profile (best-effort, debounced, once per slug) so the default follows the
 *   user across devices.
 * - Reconciles on mount: if this device has no local hint yet, seed it from the
 *   server preference (covers a fresh browser/device for an already-signed-in
 *   user). A non-empty local value is left as the authoritative recent activity
 *   for this device.
 *
 * IC2 (one boot, one fetch): every read here goes through the shared query
 * cache under `qk.profile()` — the same key the sidebar account chip fetches —
 * so this component adds ZERO requests to a boot. Before, it raw-called
 * `client.auth.getProfile()` outside the cache, putting a duplicate
 * `/v1/auth/profile` in flight alongside the sidebar's.
 */
export function LastOrgRecorder() {
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? null;
  const { client, token } = useSession();
  const qc = useQueryClient();
  const sentRef = React.useRef<string | null>(null);

  // Reconcile once per session: seed the local cache from the server when
  // empty. `ensureQueryData` reads the cached profile (or joins the in-flight
  // shell fetch) instead of issuing its own request.
  React.useEffect(() => {
    if (!token || readLastOrgSlug()) return;
    let cancelled = false;
    qc.ensureQueryData<AuthUser>({
      queryKey: qk.profile(),
      queryFn: async () => {
        const r = await wrap(async () => (await client.auth.getProfile()).user);
        if (!r.ok) throw r.error;
        return r.data;
      },
    })
      .then((user) => {
        if (!cancelled && !readLastOrgSlug() && user.lastOrgSlug) {
          writeLastOrgSlug(user.lastOrgSlug);
        }
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [client, token, qc]);

  // Record on org visit: local cache (instant) + server (best-effort, deduped,
  // debounced off the boot window). Skipped entirely when the cached profile
  // already carries this slug — the post-auth boot lands on the org the server
  // itself suggested, so PATCHing it straight back is pure noise.
  React.useEffect(() => {
    if (!orgSlug) return;
    writeLastOrgSlug(orgSlug);
    if (sentRef.current === orgSlug) return;
    const cached = qc.getQueryData<AuthUser>(qk.profile());
    if (cached?.lastOrgSlug === orgSlug) {
      sentRef.current = orgSlug;
      return;
    }
    const timer = window.setTimeout(() => {
      // Re-check at fire time: the profile query usually resolves during the
      // debounce window, and when the server already has this slug the write
      // is redundant.
      const nowCached = qc.getQueryData<AuthUser>(qk.profile());
      if (nowCached?.lastOrgSlug === orgSlug) {
        sentRef.current = orgSlug;
        return;
      }
      sentRef.current = orgSlug;
      client.auth.updateProfile({ lastOrgSlug: orgSlug }).catch(() => {
        // API-key tokens / offline — the local cache still works; reset so a
        // later navigation back to this org retries the server write.
        if (sentRef.current === orgSlug) sentRef.current = null;
      });
    }, RECORD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [orgSlug, client, qc]);

  return null;
}
