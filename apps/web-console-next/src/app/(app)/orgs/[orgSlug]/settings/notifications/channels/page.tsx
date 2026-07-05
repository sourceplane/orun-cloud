"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Pencil, Plus, Send, Slack, Trash2 } from "lucide-react";
import type { PublicNotificationChannel } from "@saas/contracts/notifications";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";

export default function ChannelsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();

  const channels = useApiQuery(qk.notificationChannels(orgId), () =>
    wrap(async () => (await client.notificationChannels.list(orgId)).notificationChannels),
  );

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<PublicNotificationChannel | null>(null);
  const [deleting, setDeleting] = React.useState<PublicNotificationChannel | null>(null);
  const [testingId, setTestingId] = React.useState<string | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (channel: PublicNotificationChannel) => {
    setEditing(channel);
    setDialogOpen(true);
  };

  const testSend = async (channel: PublicNotificationChannel) => {
    setTestingId(channel.id);
    const res = await wrap(() => client.notificationChannels.testSend(orgId, channel.id));
    setTestingId(null);
    if (!res.ok) {
      toast({ kind: "error", title: "Test send failed", description: res.error.message });
      return;
    }
    toast({ kind: "success", title: "Channel verified", description: `A probe message reached ${channel.name}.` });
    channels.reload();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const res = await wrap(() => client.notificationChannels.delete(orgId, deleting.id));
    if (!res.ok) {
      toast({ kind: "error", title: "Delete failed", description: res.error.message });
      return;
    }
    toast({ kind: "success", title: "Channel removed" });
    setDeleting(null);
    channels.reload();
  };

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Slack className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">Delivery channels</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Slack channels notification rules can deliver to. The webhook URL is write-only and never shown again.
          </p>
        </div>
        <Button type="button" onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add Slack channel
        </Button>
      </header>

      {channels.loading ? (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : channels.error ? (
        <Card>
          <CardContent className="pt-6">
            <div className="text-sm font-medium text-destructive">{channels.error.code}</div>
            <div className="text-xs text-muted-foreground">{channels.error.message}</div>
          </CardContent>
        </Card>
      ) : (channels.data ?? []).length === 0 ? (
        <EmptyState
          icon={Slack}
          title="No delivery channels"
          description="Add a Slack incoming-webhook channel, then point a notification rule at it."
          primaryAction={{ label: "Add Slack channel", onClick: openCreate }}
        />
      ) : (
        <Card className="divide-y divide-border p-0">
          {(channels.data ?? []).map((channel) => (
            <div key={channel.id} className="flex items-center gap-3 px-4 py-3.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden>
                <Slack className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{channel.name}</span>
                  {channel.lastVerifiedAt ? (
                    <Badge variant="success" className="gap-1 text-[10px]">
                      <CheckCircle2 className="h-3 w-3" />
                      verified
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">
                      unverified
                    </Badge>
                  )}
                  {channel.status && channel.status !== "active" ? (
                    <Badge variant="warning" className="text-[10px]">
                      {channel.status}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  Slack incoming webhook
                  {channel.lastVerifiedAt ? ` · last verified ${new Date(channel.lastVerifiedAt).toLocaleString()}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button type="button" size="sm" variant="outline" onClick={() => void testSend(channel)} loading={testingId === channel.id}>
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  Test
                </Button>
                <Button type="button" size="icon" variant="ghost" aria-label="Edit channel" onClick={() => openEdit(channel)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button type="button" size="icon" variant="ghost" aria-label="Delete channel" onClick={() => setDeleting(channel)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <ChannelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        orgId={orgId}
        channel={editing}
        onSaved={() => channels.reload()}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}
        title="Remove delivery channel"
        description="Rules delivering to this channel will stop reaching it. This cannot be undone."
        resourceName={deleting?.name}
        confirmLabel="Remove channel"
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function ChannelDialog({
  open,
  onOpenChange,
  orgId,
  channel,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  channel: PublicNotificationChannel | null;
  onSaved: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [name, setName] = React.useState("");
  const [webhookUrl, setWebhookUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName(channel?.name ?? "");
    setWebhookUrl("");
    setError(null);
  }, [open, channel]);

  const submit = async () => {
    setError(null);
    if (name.trim().length === 0) {
      setError("A channel name is required");
      return;
    }
    // Creating requires a URL; editing may rotate it (blank = leave unchanged).
    if (!channel && webhookUrl.trim().length === 0) {
      setError("Paste the Slack incoming-webhook URL");
      return;
    }
    setBusy(true);
    const res = channel
      ? await wrap(() =>
          client.notificationChannels.update(orgId, channel.id, {
            name: name.trim(),
            ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
          }),
        )
      : await wrap(() =>
          client.notificationChannels.create(orgId, {
            name: name.trim(),
            kind: "slack_incoming_webhook",
            webhookUrl: webhookUrl.trim(),
          }),
        );
    setBusy(false);
    if (!res.ok) {
      toast({ kind: "error", title: channel ? "Update failed" : "Create failed", description: res.error.message });
      return;
    }
    toast({ kind: "success", title: channel ? "Channel updated" : "Channel added" });
    onOpenChange(false);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{channel ? "Edit channel" : "Add Slack channel"}</DialogTitle>
          <DialogDescription>
            {channel
              ? "Rename this channel, or paste a new webhook URL to rotate it."
              : "Create an incoming webhook in Slack, then paste its URL here. It is stored encrypted and never shown again."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="channel-name">Channel name</Label>
            <Input id="channel-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="#alerts" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="channel-url">{channel ? "New webhook URL (leave blank to keep current)" : "Slack incoming-webhook URL"}</Label>
            <Input
              id="channel-url"
              type="password"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              autoComplete="off"
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} loading={busy}>
            {channel ? "Save changes" : "Add channel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
