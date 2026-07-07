"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import {
  SettingsHeader,
  SettingsPanel,
  PanelTitle,
  FormGrid,
  Field,
  FormActions,
  IdentifierRow,
  DangerZone,
} from "@/components/settings/settings-primitives";
import { workspaceIdCards } from "@/components/settings/workspace-id-cards";
import { PRODUCT_NAME } from "@/lib/app-config";
import type { PublicOrganization } from "@saas/contracts/membership";

export default function OrgSettingsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner org={org} />}</OrgScope>;
}

function Inner({ org }: { org: PublicOrganization }) {
  const idCards = workspaceIdCards(org);
  return (
    <div>
      <SettingsHeader
        title="General"
        description={`Name, slug, and the identifiers other systems use to reach this workspace within ${PRODUCT_NAME}.`}
      />

      {/* Name + slug. Renaming isn't wired from the console yet, so the inputs
          stay disabled and the save action reflects that. */}
      <SettingsPanel className="mt-[18px]">
        <FormGrid>
          <Field label="Workspace name" htmlFor="ws-name">
            <Input id="ws-name" value={org.name} disabled aria-label="Workspace name" />
          </Field>
          <Field label="Slug" htmlFor="ws-slug">
            <Input
              id="ws-slug"
              value={org.slug}
              disabled
              aria-label="Workspace slug"
              className="font-mono"
            />
          </Field>
        </FormGrid>
        <FormActions>
          <Button type="button" disabled>
            Save changes
          </Button>
        </FormActions>
      </SettingsPanel>

      {/* Durable / legacy identifiers, safe to copy and quote. */}
      <SettingsPanel className="mt-3.5">
        <PanelTitle>Identifiers</PanelTitle>
        <div className="mt-3.5 flex flex-col gap-2.5">
          {idCards.map((card) => (
            <IdentifierRow
              key={card.kind}
              label={card.title}
              value={card.value}
              action={<CopyButton value={card.value} size="icon" className="h-6 w-6 border-0 bg-transparent" label="" />}
            />
          ))}
        </div>
      </SettingsPanel>

      <DangerZone
        className="mt-3.5"
        title="Delete workspace"
        description="Permanently remove this workspace along with its repos, members, and data. Handled by support to protect against accidental, irreversible loss."
        action={
          <Button variant="outline" size="sm" className="border-destructive/25 text-destructive hover:bg-destructive/5" disabled>
            Delete…
          </Button>
        }
      />
    </div>
  );
}
