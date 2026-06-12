"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { SettingsCard } from "@/components/settings/settings-card";
import { PRODUCT_NAME } from "@/lib/app-config";

export default function OrgSettingsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner org={org} />}</OrgScope>;
}

function Inner({ org }: { org: { id: string; name: string; slug: string } }) {
  return (
    <div className="space-y-6">
      <SettingsCard
        title="Organization Name"
        description={`This is your organization's visible name within ${PRODUCT_NAME}. For example, the name of your company or department.`}
        footerHint="Renaming an organization isn't available from the console yet."
      >
        <Input value={org.name} disabled className="max-w-md" aria-label="Organization name" />
      </SettingsCard>

      <SettingsCard
        title="Organization Slug"
        description={`This is your organization's URL namespace on ${PRODUCT_NAME}. It identifies your organization across the console and the API.`}
        footerHint="Used in console URLs and API requests."
        footerAction={<CopyButton value={org.slug} />}
      >
        <div className="flex max-w-md items-stretch overflow-hidden rounded-md border bg-muted/40">
          <span className="select-none border-r px-3 py-2 text-sm text-muted-foreground">
            /orgs/
          </span>
          <input
            value={org.slug}
            disabled
            aria-label="Organization slug"
            className="w-full bg-transparent px-3 py-2 text-sm text-foreground outline-none"
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Organization ID"
        description="Use this identifier when contacting support or making API requests on behalf of this organization."
        footerHint="A unique, stable identifier for this organization."
        footerAction={<CopyButton value={org.id} />}
      >
        <Input value={org.id} disabled className="max-w-md font-mono text-xs" aria-label="Organization ID" />
      </SettingsCard>

      <SettingsCard
        tone="danger"
        title="Delete Organization"
        description="Permanently remove this organization along with its projects, members, and data. This action cannot be undone."
        footerHint="Org deletion is handled by support to protect against accidental, irreversible data loss."
        footerAction={
          <Button variant="outline" size="sm" disabled>
            Delete…
          </Button>
        }
      />
    </div>
  );
}
