"use client";

import * as React from "react";
import { useParams, useSearchParams } from "next/navigation";
import { BellRing, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { PublicNotificationRule } from "@saas/contracts/notifications";
import { OrgScope } from "@/components/shell/org-scope";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { ListCard, Pill } from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { RuleBuilderDialog } from "@/components/notifications/rule-builder";
import { RuleTestDialog } from "@/components/notifications/rule-test";
import { summarizeTargets, summarizeThrottle } from "@/components/notifications/rules";

export default function RulesPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const prefillType = searchParams?.get("type") ?? undefined;

  const rules = useApiQuery(qk.notificationRules(orgId), () =>
    wrap(async () => (await client.notificationRules.list(orgId)).notificationRules),
  );
  const channels = useApiQuery(qk.notificationChannels(orgId), () =>
    wrap(async () => (await client.notificationChannels.list(orgId)).notificationChannels),
  );

  const [builderOpen, setBuilderOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<PublicNotificationRule | null>(null);
  const [testing, setTesting] = React.useState<PublicNotificationRule | null>(null);
  const [deleting, setDeleting] = React.useState<PublicNotificationRule | null>(null);

  // Deep-link: the explorer's "create rule from this event" opens the builder
  // prefilled with the event type once.
  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (seededRef.current) return;
    if (searchParams?.get("new") === "1") {
      seededRef.current = true;
      setEditing(null);
      setBuilderOpen(true);
    }
  }, [searchParams]);

  const openCreate = () => {
    setEditing(null);
    setBuilderOpen(true);
  };
  const openEdit = (rule: PublicNotificationRule) => {
    setEditing(rule);
    setBuilderOpen(true);
  };

  const toggleEnabled = async (rule: PublicNotificationRule, enabled: boolean) => {
    const res = await wrap(() =>
      client.notificationRules.update(orgId, rule.id, { status: enabled ? "enabled" : "disabled" }),
    );
    if (!res.ok) {
      toast({ kind: "error", title: "Update failed", description: res.error.message });
      return;
    }
    rules.reload();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const res = await wrap(() => client.notificationRules.delete(orgId, deleting.id));
    if (!res.ok) {
      toast({ kind: "error", title: "Delete failed", description: res.error.message });
      return;
    }
    toast({ kind: "success", title: "Rule deleted" });
    setDeleting(null);
    rules.reload();
  };

  return (
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Notification rules"
        description="Route matching events to email or a Slack channel, with a severity floor and throttle."
        actions={
          <Button type="button" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" strokeWidth={1.8} />
            New rule
          </Button>
        }
      />

      {rules.loading ? (
        <SettingsPanel className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </SettingsPanel>
      ) : rules.error ? (
        <SettingsPanel>
          <div className="text-[13px] font-medium text-destructive">{rules.error.code}</div>
          <div className="text-xs text-muted-foreground">{rules.error.message}</div>
        </SettingsPanel>
      ) : (rules.data ?? []).length === 0 ? (
        <EmptyState
          icon={BellRing}
          title="No notification rules yet"
          description="Create a rule to get an email or Slack message when matching events happen."
          primaryAction={{ label: "New rule", onClick: openCreate }}
        />
      ) : (
        <ListCard>
          {(rules.data ?? []).map((rule) => (
            <div
              key={rule.id}
              className="flex items-start gap-3 border-t border-border/60 px-5 py-[13px] first:border-t-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{rule.name}</span>
                  <Pill tone={rule.status === "enabled" ? "success" : "neutral"}>{rule.status}</Pill>
                  {rule.projectId ? <Pill tone="neutral">project</Pill> : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span className="font-mono">{rule.eventTypes.join(", ")}</span>
                  <span aria-hidden>·</span>
                  <span>≥ {rule.minSeverity}</span>
                  <span aria-hidden>·</span>
                  <span>{summarizeTargets(rule, channels.data ?? [])}</span>
                  <span aria-hidden>·</span>
                  <span>throttle {summarizeThrottle(rule)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch
                  checked={rule.status === "enabled"}
                  onCheckedChange={(on) => void toggleEnabled(rule, on)}
                  aria-label={`Enable ${rule.name}`}
                />
                <Button type="button" size="icon" variant="ghost" aria-label="Test rule" onClick={() => setTesting(rule)}>
                  <Play className="h-4 w-4" strokeWidth={1.8} />
                </Button>
                <Button type="button" size="icon" variant="ghost" aria-label="Edit rule" onClick={() => openEdit(rule)}>
                  <Pencil className="h-4 w-4" strokeWidth={1.8} />
                </Button>
                <Button type="button" size="icon" variant="ghost" aria-label="Delete rule" onClick={() => setDeleting(rule)}>
                  <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                </Button>
              </div>
            </div>
          ))}
        </ListCard>
      )}

      <RuleBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        orgId={orgId}
        rule={editing}
        channels={channels.data ?? []}
        prefillType={editing ? undefined : prefillType}
        onSaved={() => rules.reload()}
      />
      <RuleTestDialog open={testing !== null} onOpenChange={(o) => (!o ? setTesting(null) : undefined)} orgId={orgId} rule={testing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}
        title="Delete notification rule"
        description="This rule will stop matching events immediately. This cannot be undone."
        resourceName={deleting?.name}
        confirmLabel="Delete rule"
        onConfirm={confirmDelete}
      />
    </div>
  );
}
