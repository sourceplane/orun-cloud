"use client";

import * as React from "react";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { ListCard, PersonAvatar, Pill } from "@/components/ui/northwind";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { MEMBER_ROLE_OPTIONS, primaryRole, isRoleChange } from "./members";

/**
 * Members roster with inline role editing (saas-settings-ia SI3). The role
 * `Select` wires the shipped `PATCH /members/:id` (`updateMemberRole`) that the
 * old read-only roster never exposed. Deny-safe: the server authorizes the
 * change and a 403 rolls the row back with a toast. Provenance (direct / via
 * team / account-cascaded) lives on the Access tab.
 */
export function MembersPanel({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const members = useApiQuery(qk.members(orgId), () =>
    wrap(async () => (await client.memberships.listMembers(orgId)).members),
  );

  const [pendingRemove, setPendingRemove] = React.useState<{ id: string; subjectId: string } | null>(
    null,
  );
  // Rows with an in-flight role change (disabled while saving).
  const [savingRole, setSavingRole] = React.useState<Record<string, boolean>>({});

  const removeMember = async (id: string) => {
    const r = await wrap(() => client.memberships.removeMember(orgId, id));
    if (!r.ok) {
      toast({ kind: "error", title: "Remove failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Member removed" });
    members.reload();
  };

  const changeRole = async (memberId: string, current: string, next: string) => {
    if (!isRoleChange(current, next)) return;
    setSavingRole((s) => ({ ...s, [memberId]: true }));
    const r = await wrap(() => client.memberships.updateMemberRole(orgId, memberId, { role: next }));
    setSavingRole((s) => ({ ...s, [memberId]: false }));
    if (!r.ok) {
      toast({ kind: "error", title: "Role change failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Role updated", description: `Now ${next}` });
    members.reload();
  };

  return (
    <div className="space-y-[18px]">
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        title="Remove member"
        description="They immediately lose access to this workspace and all of its repos. You can re-invite them later."
        resourceName={pendingRemove?.subjectId}
        confirmLabel="Remove member"
        onConfirm={() => (pendingRemove ? removeMember(pendingRemove.id) : undefined)}
      />
      <SettingsHeader
        title="Members"
        description="Users and service principals attached to this workspace. Change a role inline; see how access reaches each person on the Access tab."
      />

      {members.loading ? (
        <SettingsPanel className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </SettingsPanel>
      ) : members.error ? (
        <SettingsPanel tone="danger">
          <div className="text-[13.5px] font-semibold text-destructive">{members.error.code}</div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {members.error.message}
          </p>
        </SettingsPanel>
      ) : !members.data || members.data.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No members"
          description="Invite teammates from the Pending tab."
        />
      ) : (
        <ListCard>
          {members.data.map((m) => {
            const role = primaryRole(m.roles);
            const multi = m.roles.length > 1;
            return (
              <div
                key={m.id}
                className="flex items-center gap-3 border-t border-border/50 px-5 py-[13px] first:border-t-0"
              >
                <PersonAvatar name={m.subjectId} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{m.subjectId}</div>
                  <div className="truncate text-[11.5px] text-muted-foreground">
                    {m.subjectType}
                    {" · joined "}
                    {new Date(m.joinedAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {multi && <Pill tone="neutral">+{m.roles.length - 1}</Pill>}
                  <Select
                    value={role}
                    disabled={savingRole[m.id] ?? false}
                    onValueChange={(next) => changeRole(m.id, role, next)}
                  >
                    <SelectTrigger className="h-8 w-[132px] text-[12.5px]" aria-label={`Role for ${m.subjectId}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MEMBER_ROLE_OPTIONS.map((r) => (
                        <SelectItem key={r} value={r} className="text-[12.5px]">
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Pill tone={m.status === "active" ? "success" : "warning"}>{m.status}</Pill>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setPendingRemove({ id: m.id, subjectId: m.subjectId })}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            );
          })}
        </ListCard>
      )}
    </div>
  );
}
