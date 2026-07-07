"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { z } from "zod";
import { Plus, Mail } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ZodForm } from "@/components/ui/zod-form";
import { PreconditionInsight } from "@/components/precondition/insight";
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { ListCard, Pill } from "@/components/ui/northwind";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { ORGANIZATION_ROLES } from "@saas/contracts/membership";
import { wrap, type ApiErrorBody } from "@/lib/api";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
  role: z.enum(ORGANIZATION_ROLES),
});

export default function InvitationsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const invs = useApiQuery(qk.invitations(orgId), () =>
    wrap(async () => (await client.memberships.listInvitations(orgId)).invitations),
  );
  const [open, setOpen] = React.useState(false);
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);

  return (
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Invitations"
        description="Pending and historical invites for this workspace."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4" strokeWidth={1.8} />
                Invite member
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Send invitation</DialogTitle>
                <DialogDescription>
                  Invite a teammate by email to join this workspace.
                </DialogDescription>
              </DialogHeader>
              <ZodForm
                schema={schema}
                defaultValues={{ email: "", role: "viewer" }}
                fields={[
                  { name: "email", label: "Email", type: "email", placeholder: "user@example.com" },
                  { name: "role", label: "Role", hint: ORGANIZATION_ROLES.join(" · ") },
                ]}
                submitLabel="Send invite"
                cancel={{ label: "Cancel", onClick: () => setOpen(false) }}
                onSubmit={async (v) => {
                  const r = await wrap(() =>
                    client.memberships.createInvitation(orgId, { email: v.email, role: v.role }),
                  );
                  if (!r.ok) {
                    if (r.error.code === "precondition_failed") setPrecondition(r.error);
                    else toast({ kind: "error", title: "Invite failed", description: r.error.message });
                    return;
                  }
                  toast({
                    kind: "success",
                    title: "Invitation sent",
                    description: r.data.delivery?.token ? `dev token: ${r.data.delivery.token}` : undefined,
                  });
                  setOpen(false);
                  invs.reload();
                }}
              />
            </DialogContent>
          </Dialog>
        }
      />

      {precondition && (
        <PreconditionInsight error={precondition} resource="invitation" onDismiss={() => setPrecondition(null)} />
      )}

      {invs.loading ? (
        <SettingsPanel className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </SettingsPanel>
      ) : invs.error ? (
        <SettingsPanel tone="danger">
          <div className="text-[13.5px] font-semibold text-destructive">{invs.error.code}</div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {invs.error.message}
          </p>
        </SettingsPanel>
      ) : !invs.data || invs.data.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No invitations"
          description="Invite teammates to collaborate in this workspace."
          primaryAction={{ label: "Invite member", onClick: () => setOpen(true) }}
        />
      ) : (
        <ListCard>
          {invs.data.map((i) => (
            <div
              key={i.id}
              className="flex items-center gap-3 border-t border-border/50 px-5 py-[13px] first:border-t-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{i.email}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {i.role}
                  {" · created "}
                  {new Date(i.createdAt).toLocaleDateString()}
                  {" · expires "}
                  {new Date(i.expiresAt).toLocaleDateString()}
                </div>
              </div>
              <Pill
                tone={
                  i.status === "pending"
                    ? "warning"
                    : i.status === "accepted"
                      ? "success"
                      : "neutral"
                }
              >
                {i.status}
              </Pill>
              {i.status === "pending" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const r = await wrap(() =>
                      client.memberships.revokeInvitation(orgId, i.id),
                    );
                    if (!r.ok) {
                      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
                      return;
                    }
                    toast({ kind: "success", title: "Invitation revoked" });
                    invs.reload();
                  }}
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </ListCard>
      )}
    </div>
  );
}
