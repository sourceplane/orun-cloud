"use client";

import * as React from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { MembersPanel } from "@/components/people/members-panel";
import { InvitationsPanel } from "@/components/people/invitations-panel";
import { RolesPanel } from "@/components/people/roles-panel";
import { AccessPanel } from "@/components/people/access-panel";
import { buildPeopleTabs, resolvePeopleTab } from "@/components/people/people-tabs";

/**
 * People & Access (saas-settings-ia SI3): Members, Invitations, and Access —
 * three former settings pages — consolidated into one deep-linkable tabbed
 * surface. The active tab lives in `?tab=` so links and redirects land directly
 * on the right tab; Members is the default (bare) tab.
 */
export default function PeoplePage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  const search = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const tab = resolvePeopleTab(search?.get("tab"));
  const tabs = buildPeopleTabs(slug);

  const onTab = (next: string) => {
    // Members is the bare surface; other tabs carry `?tab=`. Keep the URL the
    // source of truth so back/forward and deep links work.
    const href = next === "members" ? pathname : `${pathname}?tab=${next}`;
    router.replace(href);
  };

  return (
    <OrgScope slug={slug}>
      {(org) => (
        <div className="space-y-5">
          <div>
            <h1 className="font-serif text-[26px] font-medium tracking-[-0.01em]">People &amp; Access</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Everyone who can reach this workspace, what they can do, and how they got it.
            </p>
          </div>
          <Tabs value={tab} onValueChange={onTab}>
            <TabsList>
              {tabs.map((t) => (
                <TabsTrigger key={t.key} value={t.key}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="members" className="mt-5">
              <MembersPanel orgId={org.id} />
            </TabsContent>
            <TabsContent value="pending" className="mt-5">
              <InvitationsPanel orgId={org.id} />
            </TabsContent>
            <TabsContent value="roles" className="mt-5">
              <RolesPanel />
            </TabsContent>
            <TabsContent value="access" className="mt-5">
              <AccessPanel orgId={org.id} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </OrgScope>
  );
}
