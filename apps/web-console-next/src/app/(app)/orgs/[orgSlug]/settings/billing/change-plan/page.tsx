"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { QuietLink } from "@/components/ui/northwind";
import { SettingsHeader } from "@/components/settings/settings-primitives";
import { ChangePlanCards } from "@/components/billing/change-plan-cards";

export default function ChangePlanPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => (
        <div className="space-y-[18px]">
          <div className="space-y-3">
            <QuietLink href={`/orgs/${slug}/settings/billing`} className="inline-flex items-center gap-1">
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} /> Back to Billing
            </QuietLink>
            <SettingsHeader
              title="Change plan"
              description="Pick a new plan for this workspace. You can change again at any time."
            />
          </div>
          <ChangePlanCards orgId={org.id} orgSlug={slug} />
        </div>
      )}
    </OrgScope>
  );
}
