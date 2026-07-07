"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import type { NotificationCategory } from "@saas/contracts/notifications";
import { OrgScope } from "@/components/shell/org-scope";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import {
  PREFERENCE_CATEGORIES,
  effectiveCategories,
  buildUpdatedCategories,
} from "@/components/notifications/preferences";

export default function NotificationsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  // The edge pins the subject to the session actor; we only scope by org.
  const prefs = useApiQuery(qk.notificationPrefs(orgId), () =>
    wrap(async () => (await client.notifications.getPreferences({ orgId })).preferences),
  );
  const profile = useApiQuery(qk.profile(), () =>
    wrap(async () => (await client.auth.getProfile()).user),
  );

  const stored = effectiveCategories(prefs.data);
  // Optimistic per-category overrides while an update is in flight.
  const [overrides, setOverrides] = React.useState<Partial<Record<NotificationCategory, boolean>>>(
    {},
  );
  const current = { ...stored, ...overrides };

  const toggle = async (category: NotificationCategory, enabled: boolean) => {
    if (!profile.data) return;
    setOverrides((o) => ({ ...o, [category]: enabled }));
    const r = await wrap(() =>
      client.notifications.updatePreferences({
        orgId,
        subjectKind: "user",
        subjectId: profile.data!.id,
        channel: "email",
        categories: buildUpdatedCategories(current, category, enabled),
      }),
    );
    if (!r.ok) {
      setOverrides((o) => {
        const next = { ...o };
        delete next[category];
        return next;
      });
      toast({ kind: "error", title: "Update failed", description: r.error.message });
      return;
    }
    prefs.reload();
  };

  return (
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Notifications"
        description="Which categories of email you receive for this workspace. Applies to your account only."
      />

      {prefs.loading || profile.loading ? (
        <SettingsPanel className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </SettingsPanel>
      ) : prefs.error ? (
        <SettingsPanel>
          <div className="text-[13px] font-medium text-destructive">Failed to load preferences</div>
          <div className="text-xs text-muted-foreground">{prefs.error.message}</div>
        </SettingsPanel>
      ) : (
        <SettingsPanel className="px-0 py-0">
          {PREFERENCE_CATEGORIES.map((c) => (
            <div
              key={c.key}
              className="flex items-center justify-between gap-4 border-t border-border/60 px-6 py-[13px] first:border-t-0"
            >
              <div className="min-w-0">
                <div className="text-[13px] font-medium" id={`pref-${c.key}`}>
                  {c.label}
                </div>
                <div className="text-[11.5px] leading-normal text-muted-foreground">{c.description}</div>
              </div>
              <Switch
                checked={current[c.key]}
                onCheckedChange={(on) => void toggle(c.key, on)}
                aria-labelledby={`pref-${c.key}`}
                disabled={!profile.data}
              />
            </div>
          ))}
        </SettingsPanel>
      )}
    </div>
  );
}
