"use client";

import * as React from "react";
import { Check, Minus } from "lucide-react";
import { SettingsHeader } from "@/components/settings/settings-primitives";
import { ListCard } from "@/components/ui/northwind";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { ROLE_CATALOG, CAPABILITY_AREAS, roleLevel } from "./roles";

function LevelMark({ level }: { level: ReturnType<typeof roleLevel> }) {
  if (level === "full") {
    return <Check className="mx-auto h-4 w-4 text-foreground" aria-label="allowed" />;
  }
  if (level === "partial") {
    return <span className="mx-auto block h-2 w-2 rounded-full bg-muted-foreground/60" aria-label="partial" />;
  }
  return <Minus className="mx-auto h-3.5 w-3.5 text-muted-foreground/40" aria-label="not allowed" />;
}

/**
 * Roles reference (saas-settings-ia SI4): a capability-area matrix of what each
 * organization role can do, plus a per-role summary. Read-only — the seam where
 * custom roles (teams-governance TG) land. Mirrors tenancy-and-rbac.md; the
 * authoritative per-action catalog is in policy-engine.
 */
export function RolesPanel() {
  return (
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Roles"
        description="What each role can do in this workspace. The builder role is shown to teammates as Developer."
      />

      <ListCard className="overflow-x-auto">
        <Table className="min-w-[560px]">
          <THead>
            <TR>
              <TH className="text-left">Capability</TH>
              {ROLE_CATALOG.map((r) => (
                <TH key={r.key} className="text-center">
                  {r.label}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {CAPABILITY_AREAS.map((area) => (
              <TR key={area.key}>
                <TD className="whitespace-nowrap font-medium">{area.label}</TD>
                {ROLE_CATALOG.map((r) => (
                  <TD key={r.key} className="text-center">
                    <LevelMark level={roleLevel(r.key, area.key)} />
                  </TD>
                ))}
              </TR>
            ))}
          </TBody>
        </Table>
      </ListCard>

      <div className="space-y-2">
        {ROLE_CATALOG.map((r) => (
          <div key={r.key} className="rounded-[9px] border border-border/60 px-4 py-3">
            <div className="text-[13px] font-semibold">{r.label}</div>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground">{r.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
