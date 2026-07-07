"use client";

import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import type { PublicOrganization } from "@saas/contracts/membership";
import { useOrgBySlug } from "@/lib/use-org";
import { readLastOrgSlug, clearLastOrgSlug } from "@/lib/last-org";
import { AlertTriangle } from "lucide-react";

/**
 * Shared wrapper for per-org pages: resolves slug → org, surfaces
 * loading and not-found states uniformly so each page can stay focused
 * on its resource.
 */
export function OrgScope({
  slug,
  children,
  bare = false,
}: {
  slug: string;
  children: (org: PublicOrganization) => React.ReactNode;
  /**
   * Skip the shared breadcrumb + vertical rhythm wrapper. For full-bleed routes
   * that own their own chrome (e.g. the catalog service page, which renders its
   * own breadcrumb bar) so the path isn't shown twice.
   */
  bare?: boolean;
}) {
  const { org, loading, error } = useOrgBySlug(slug);

  // Self-heal the remembered-org hint: if this slug resolves to nothing (org
  // archived or access revoked), drop it so the default landing falls back to
  // the picker instead of looping back to a dead org.
  React.useEffect(() => {
    if (!loading && !error && !org && readLastOrgSlug() === slug) {
      clearLastOrgSlug();
    }
  }, [loading, error, org, slug]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[1060px] space-y-4 px-5 pt-8 sm:px-8 lg:px-12 lg:pt-[52px]">
        <Skeleton className="h-8 w-48" />
        <div className="grid sm:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-40" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="mx-auto mt-8 w-full max-w-lg lg:mt-[52px]">
        <CardHeader>
          <CardTitle className="text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Failed to load workspace
          </CardTitle>
          <CardDescription>{error.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!org) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Workspace not found"
        description={`No workspace matches slug “${slug}”. It may have been archived or you no longer have access.`}
        primaryAction={{ label: "Back to workspaces", href: "/orgs" }}
      />
    );
  }

  // Northwind screens own their chrome: top-level surfaces have no persistent
  // breadcrumb (drill-downs render their own via ui/northwind `Breadcrumbs`),
  // so the wrapper is pass-through in both modes. `bare` is kept for callers.
  void bare;
  return <>{children(org)}</>;
}
