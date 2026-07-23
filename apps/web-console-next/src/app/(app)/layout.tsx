"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { BottomTabs } from "@/components/shell/bottom-tabs";
import { LastOrgRecorder } from "@/components/shell/last-org-recorder";
import { PaletteEntitySource } from "@/components/shell/palette-entity-source";
import { Skeleton } from "@/components/ui/skeleton";
import { useRequireAuth } from "@/lib/use-async";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";

/**
 * App shell. The frame (sidebar + topbar rails) paints immediately so there's
 * no full-screen blank flash; the data-dependent shell content and page
 * children mount only once the session token has hydrated (`ready`), which
 * avoids firing requests with no token. `useRequireAuth` still redirects to
 * /login when there is genuinely no token (Task 0130 / PERF1).
 *
 * On mobile the desktop sidebar collapses (it's `hidden md:flex`); navigation
 * is provided by the topbar hamburger drawer and the bottom tab bar, so the
 * main column reserves bottom space for the tab bar + home-indicator inset.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const ready = useRequireAuth();
  return (
    <div className="flex min-h-screen bg-background">
      {ready ? (
        <Sidebar />
      ) : (
        <aside
          className="sticky top-0 hidden h-dvh w-[230px] shrink-0 self-start border-r bg-secondary md:flex"
          aria-hidden
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {ready ? (
          <Topbar />
        ) : (
          <header
            className="sticky top-0 z-30 h-12 border-b bg-background/80 backdrop-blur-md pt-safe md:hidden"
            aria-hidden
          />
        )}
        {/* Screens own their container (see ui/northwind.tsx `Screen`): a
            1060px centered column with Northwind rhythm. The shell only
            reserves space for the mobile tab bar + home indicator. */}
        <main className="w-full flex-1 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] md:pb-0">
          {ready ? children : <ShellSkeleton />}
        </main>
        {ready && <BottomTabs />}
      </div>
      {ready && <LastOrgRecorder />}
      {/* IC7: feeds ⌘K from the shared query cache (entities/docs/teams). */}
      {ready && <PaletteEntitySource />}
      {ready && <OnboardingGate />}
    </div>
  );
}

/**
 * Invisible guard: the console has no working view without an organization, so
 * an authenticated user with zero orgs is normally sent to the mandatory
 * `/onboarding` flow (create the parent org + pick a plan) from anywhere in the
 * shell. Exception (saas invitation login flow): a user with zero orgs but a
 * pending invitation is invited into an *existing* workspace and must not be
 * forced to create one — they are routed to `/orgs`, which surfaces the
 * invitation to accept. Backed by the shared `orgs`/`myInvitations` queries the
 * shell already fetches; on fetch errors it falls back to onboarding rather than
 * trapping the user on a blank shell.
 */
function OnboardingGate() {
  const router = useRouter();
  const pathname = usePathname();
  const { client } = useSession();
  const orgs = useApiQuery(qk.orgs(), () =>
    wrap(async () => (await client.organizations.list()).organizations),
  );
  const invites = useApiQuery(qk.myInvitations(), () =>
    wrap(async () => (await client.memberships.listMyInvitations()).invitations),
  );
  React.useEffect(() => {
    if (!orgs.data || orgs.data.length > 0) return;
    // Decide only once the invitations list has settled (loaded or errored), so
    // an invited user isn't briefly funneled to onboarding before we know.
    if (!invites.data && !invites.error) return;
    if (invites.data && invites.data.length > 0) {
      if (pathname !== "/orgs") router.replace("/orgs");
    } else {
      router.replace("/onboarding");
    }
  }, [orgs.data, invites.data, invites.error, pathname, router]);
  return null;
}

function ShellSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1060px] space-y-6 px-5 pt-8 sm:px-8 lg:px-12 lg:pt-[52px]" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  );
}
