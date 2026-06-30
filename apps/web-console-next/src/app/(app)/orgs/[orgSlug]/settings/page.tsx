"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { SettingsCard } from "@/components/settings/settings-card";
import { workspaceIdCards } from "@/components/settings/workspace-id-cards";
import { PRODUCT_NAME } from "@/lib/app-config";
import type { PublicOrganization } from "@saas/contracts/membership";

const ID_CARD_COPY: Record<
  "durable" | "legacy",
  { description: string; footerHint: string; ariaLabel: string }
> = {
  durable: {
    description:
      "Your durable, immutable Workspace ID. Safe to commit to intent.yaml, quote to support, and use in API requests — it never changes, even if you rename the workspace.",
    footerHint: "The stable identifier to use everywhere.",
    ariaLabel: "Workspace ID",
  },
  legacy: {
    description:
      "The legacy internal identifier for this workspace. Still accepted in API requests, but prefer the Workspace ID above for anything you store or share.",
    footerHint: "Retained for back-compatibility.",
    ariaLabel: "Legacy Workspace ID",
  },
};

export default function OrgSettingsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner org={org} />}</OrgScope>;
}

function Inner({ org }: { org: PublicOrganization }) {
  return (
    <div className="space-y-6">
      <SettingsCard
        title="Workspace Name"
        description={`This is your workspace's visible name within ${PRODUCT_NAME}. For example, the name of your company or department.`}
        footerHint="Renaming a workspace isn't available from the console yet."
      >
        <Input value={org.name} disabled className="max-w-md" aria-label="Workspace name" />
      </SettingsCard>

      <SettingsCard
        title="Workspace Slug"
        description={`This is your workspace's URL namespace on ${PRODUCT_NAME}. It identifies your workspace across the console and the API.`}
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
            aria-label="Workspace slug"
            className="w-full bg-transparent px-3 py-2 text-sm text-foreground outline-none"
          />
        </div>
      </SettingsCard>

      {workspaceIdCards(org).map((card) => {
        const copy = ID_CARD_COPY[card.kind];
        return (
          <SettingsCard
            key={card.kind}
            title={card.title}
            description={copy.description}
            footerHint={copy.footerHint}
            footerAction={<CopyButton value={card.value} />}
          >
            <Input
              value={card.value}
              disabled
              className="max-w-md font-mono text-xs"
              aria-label={copy.ariaLabel}
            />
          </SettingsCard>
        );
      })}

      <SettingsCard
        tone="danger"
        title="Delete Workspace"
        description="Permanently remove this workspace along with its repos, members, and data. This action cannot be undone."
        footerHint="Workspace deletion is handled by support to protect against accidental, irreversible data loss."
        footerAction={
          <Button variant="outline" size="sm" disabled>
            Delete…
          </Button>
        }
      />
    </div>
  );
}
