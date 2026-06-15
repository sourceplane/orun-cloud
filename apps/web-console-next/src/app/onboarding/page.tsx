"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateOrgFlow } from "@/components/orgs/create-org-flow";
import { pickAccountBillingOrg } from "@/components/billing/account-org";
import { useSession } from "@/lib/session";
import { useRequireAuth } from "@/lib/use-async";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { defaultOrgDestination, readLastOrgSlug } from "@/lib/last-org";
import { CONSOLE_TITLE } from "@/lib/app-config";
import { OrunMark } from "@/components/brand/logo";

/**
 * Mandatory first-run onboarding (Supabase/Vercel-style): a focused, full-screen
 * surface — no app shell — where a freshly signed-up user names their parent
 * organization, picks a plan, and chooses a starting point before anything
 * else. It renders the same `CreateOrgFlow` as the in-app "add organization"
 * page, so the two are one product experience. The console has no org-less
 * working view, so this is the only destination for an authenticated user with
 * zero organizations (the shell's `OnboardingGate` funnels here).
 *
 * The forward-vs-create decision is made ONCE, on the first settled org list:
 *  - already has orgs  → a deep link by an onboarded user → forward to an org;
 *  - zero orgs         → show the create flow and stay put.
 * It is deliberately not re-evaluated afterward, so the post-create cache
 * update (which makes the list non-empty) does NOT trigger a second forward
 * that would race `CreateOrgFlow`'s own navigation and flash the form.
 */
export default function OnboardingPage() {
  const ready = useRequireAuth();
  const router = useRouter();
  const { client, setToken } = useSession();
  const orgs = useApiQuery(
    qk.orgs(),
    () => wrap(async () => (await client.organizations.list()).organizations),
    { enabled: ready },
  );

  const [phase, setPhase] = React.useState<"deciding" | "create" | "forwarding">("deciding");
  React.useEffect(() => {
    if (phase !== "deciding") return;
    if (orgs.error) {
      setPhase("create");
      return;
    }
    if (!orgs.data) return; // wait for the first settled list
    if (orgs.data.length === 0) {
      setPhase("create");
      return;
    }
    const last = readLastOrgSlug();
    const slug = orgs.data.some((o) => o.slug === last)
      ? last
      : pickAccountBillingOrg(orgs.data)!.slug;
    setPhase("forwarding");
    router.replace(defaultOrgDestination(slug));
  }, [phase, orgs.data, orgs.error, router]);

  return (
    <div className="bg-grid-glow min-h-screen bg-background">
      <header className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 md:px-8">
        <div className="flex items-center gap-2.5">
          <OrunMark size={26} className="text-foreground" />
          <span className="text-sm font-semibold tracking-tight">{CONSOLE_TITLE}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setToken(null);
            router.replace("/login");
          }}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 md:px-8">
        {phase !== "create" ? (
          <OnboardingSkeleton />
        ) : orgs.error && (orgs.data?.length ?? 0) === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">Failed to load your account</CardTitle>
              <CardDescription>{orgs.error.message}</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <CreateOrgFlow mode="parent" billingParent={null} variant="onboarding" />
        )}
      </main>
    </div>
  );
}

function OnboardingSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex gap-10 pt-2">
        <div className="hidden w-56 shrink-0 space-y-8 md:block">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 flex-1 rounded-lg" />
      </div>
    </div>
  );
}
