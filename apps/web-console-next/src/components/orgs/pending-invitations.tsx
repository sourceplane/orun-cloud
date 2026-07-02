"use client";

import * as React from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";

/**
 * Pending invitations for the signed-in user's verified email (saas invitation
 * login flow). The invite email carries no token link — it tells the recipient
 * to "sign in with this email address to view and accept the invitation" — so
 * this is where those invitations surface after login.
 *
 * Renders nothing until at least one still-actionable invitation exists, so a
 * caller can drop it at the top of a page unconditionally. Accepting joins the
 * workspace (token-less, matched on the session email) and calls `onAccepted`
 * so the host can refresh its own org list.
 */
export function PendingInvitations({ onAccepted }: { onAccepted?: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const invites = useApiQuery(qk.myInvitations(), () =>
    wrap(async () => (await client.memberships.listMyInvitations()).invitations),
  );
  const [acceptingId, setAcceptingId] = React.useState<string | null>(null);

  const onAccept = React.useCallback(
    async (invitationId: string) => {
      setAcceptingId(invitationId);
      const r = await wrap(() => client.memberships.acceptMyInvitation(invitationId));
      setAcceptingId(null);
      if (!r.ok) {
        toast({ kind: "error", title: "Could not accept invitation", description: r.error.message });
        return;
      }
      toast({ kind: "success", title: "Invitation accepted", description: "You now have access to the workspace." });
      invites.reload();
      onAccepted?.();
    },
    [client, toast, invites, onAccepted],
  );

  const items = invites.data ?? [];
  if (items.length === 0) return null;

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Pending invitations
        </CardTitle>
        <CardDescription>
          You&apos;ve been invited to join {items.length === 1 ? "a workspace" : "these workspaces"}. Accept to gain access.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((inv) => (
          <div
            key={inv.id}
            className="flex items-center justify-between gap-4 rounded-md border bg-background px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{inv.org.name}</div>
              <div className="text-xs text-muted-foreground">
                {inv.org.slug} · Role: {inv.role}
              </div>
            </div>
            <Button size="sm" disabled={acceptingId !== null} onClick={() => void onAccept(inv.id)}>
              {acceptingId === inv.id ? "Accepting…" : "Accept"}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
