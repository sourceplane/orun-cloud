"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckCircle2, Lock, Pencil, Plus, Search, Send, Slack, Trash2 } from "lucide-react";
import type { PublicNotificationChannel } from "@saas/contracts/notifications";
import type { SlackChannelRef } from "@saas/contracts/integrations";
import { OrgScope } from "@/components/shell/org-scope";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { ListCard, Pill } from "@/components/ui/northwind";
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
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
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
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Delivery channels"
        description="Slack channels notification rules can deliver to. The webhook URL is write-only and never shown again."
        actions={
          <Button type="button" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" strokeWidth={1.8} />
            Add Slack channel
          </Button>
        }
      />

      {channels.loading ? (
        <SettingsPanel className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </SettingsPanel>
      ) : channels.error ? (
        <SettingsPanel>
          <div className="text-[13px] font-medium text-destructive">{channels.error.code}</div>
          <div className="text-xs text-muted-foreground">{channels.error.message}</div>
        </SettingsPanel>
      ) : (channels.data ?? []).length === 0 ? (
        <EmptyState
          icon={Slack}
          title="No delivery channels"
          description="Add a Slack incoming-webhook channel, then point a notification rule at it."
          primaryAction={{ label: "Add Slack channel", onClick: openCreate }}
        />
      ) : (
        <ListCard>
          {(channels.data ?? []).map((channel) => (
            <div
              key={channel.id}
              className="flex items-center gap-3 border-t border-border/60 px-5 py-[13px] first:border-t-0"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden>
                <Slack className="h-4 w-4" strokeWidth={1.8} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{channel.name}</span>
                  {channel.lastVerifiedAt ? (
                    <Pill tone="success" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" strokeWidth={1.8} />
                      verified
                    </Pill>
                  ) : (
                    <Pill tone="neutral">unverified</Pill>
                  )}
                  <Pill tone="neutral">{channel.kind === "slack_app" ? "Bot" : "Webhook"}</Pill>
                  {channel.status && channel.status !== "active" ? (
                    <Pill tone="warning">{channel.status}</Pill>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {channel.kind === "slack_app" ? "Slack workspace bot" : "Slack incoming webhook"}
                  {channel.lastVerifiedAt ? ` · last verified ${new Date(channel.lastVerifiedAt).toLocaleString()}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button type="button" size="sm" variant="outline" onClick={() => void testSend(channel)} loading={testingId === channel.id}>
                  <Send className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.8} />
                  Test
                </Button>
                <Button type="button" size="icon" variant="ghost" aria-label="Edit channel" onClick={() => openEdit(channel)}>
                  <Pencil className="h-4 w-4" strokeWidth={1.8} />
                </Button>
                <Button type="button" size="icon" variant="ghost" aria-label="Delete channel" onClick={() => setDeleting(channel)}>
                  <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                </Button>
              </div>
            </div>
          ))}
        </ListCard>
      )}

      <ChannelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        orgId={orgId}
        orgSlug={orgSlug}
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
  orgSlug,
  channel,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  orgSlug: string;
  channel: PublicNotificationChannel | null;
  onSaved: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [name, setName] = React.useState("");
  const [webhookUrl, setWebhookUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // slack_app flow state (create mode only, IH2 §4.2).
  const [kind, setKind] = React.useState<"slack_app" | "slack_incoming_webhook">("slack_app");
  const [connectionId, setConnectionId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [slackChannels, setSlackChannels] = React.useState<SlackChannelRef[] | null>(null);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [pickerError, setPickerError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<SlackChannelRef | null>(null);

  // Includes inherited/account-shared connections — they arrive in the same list.
  const integrations = useApiQuery(
    qk.integrations(orgId),
    () => wrap(async () => (await client.integrations.list(orgId)).connections),
    { enabled: open && !channel },
  );
  const slackConnections = React.useMemo(
    () => (integrations.data ?? []).filter((c) => c.provider === "slack" && c.status === "active"),
    [integrations.data],
  );
  const hasSlack = slackConnections.length > 0;
  const effectiveKind = !channel && hasSlack ? kind : "slack_incoming_webhook";
  const effectiveConnectionId = connectionId ?? slackConnections[0]?.id ?? null;

  React.useEffect(() => {
    if (!open) return;
    setName(channel?.name ?? "");
    setWebhookUrl("");
    setError(null);
    setKind("slack_app");
    setConnectionId(null);
    setQuery("");
    setSlackChannels(null);
    setNextCursor(null);
    setPickerError(null);
    setSelected(null);
  }, [open, channel]);

  // Debounced first-page channel search for the slack_app picker.
  React.useEffect(() => {
    if (!open || channel || effectiveKind !== "slack_app" || !effectiveConnectionId) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        const r = await wrap(() =>
          client.integrations.listSlackChannels(orgId, effectiveConnectionId, {
            ...(query.trim() ? { query: query.trim() } : {}),
          }),
        );
        if (cancelled) return;
        if (!r.ok) {
          setPickerError(r.error.message);
          setSlackChannels([]);
          setNextCursor(null);
          return;
        }
        setPickerError(null);
        setSlackChannels(r.data.channels);
        setNextCursor(r.data.nextCursor);
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, channel, effectiveKind, effectiveConnectionId, query, orgId, client]);

  const loadMore = async () => {
    if (!effectiveConnectionId || !nextCursor) return;
    setLoadingMore(true);
    const r = await wrap(() =>
      client.integrations.listSlackChannels(orgId, effectiveConnectionId, {
        ...(query.trim() ? { query: query.trim() } : {}),
        cursor: nextCursor,
      }),
    );
    setLoadingMore(false);
    if (!r.ok) {
      setPickerError(r.error.message);
      return;
    }
    setSlackChannels((prev) => [...(prev ?? []), ...r.data.channels]);
    setNextCursor(r.data.nextCursor);
  };

  const pickChannel = (ch: SlackChannelRef) => {
    setSelected(ch);
    // The notification channel's own name defaults to the picked Slack channel.
    setName((prev) => (prev.trim() ? prev : `#${ch.name}`));
  };

  const submit = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("A channel name is required");
      return;
    }
    const createAsApp = !channel && effectiveKind === "slack_app";
    const pickedConnection = effectiveConnectionId;
    const picked = selected;
    if (createAsApp && (!pickedConnection || !picked)) {
      setError("Pick a Slack channel for the bot to post to");
      return;
    }
    // Creating a webhook channel requires a URL; editing may rotate it (blank = leave unchanged).
    if (!channel && !createAsApp && webhookUrl.trim().length === 0) {
      setError("Paste the Slack incoming-webhook URL");
      return;
    }
    setBusy(true);
    const res = channel
      ? await wrap(() =>
          client.notificationChannels.update(orgId, channel.id, {
            name: trimmedName,
            ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
          }),
        )
      : createAsApp && pickedConnection && picked
        ? await wrap(() =>
            client.notificationChannels.create(orgId, {
              name: trimmedName,
              kind: "slack_app",
              connectionId: pickedConnection,
              channelExternalId: picked.id,
              channelName: picked.name,
            }),
          )
        : await wrap(() =>
            client.notificationChannels.create(orgId, {
              name: trimmedName,
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
              : effectiveKind === "slack_app"
                ? "Pick a channel for the workspace bot to deliver to. No webhook needed — the bot posts through the Slack connection."
                : "Create an incoming webhook in Slack, then paste its URL here. It is stored encrypted and never shown again."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!channel && hasSlack ? (
            <div className="space-y-1.5">
              <Label>Delivery method</Label>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant={effectiveKind === "slack_app" ? "default" : "outline"}
                  onClick={() => setKind("slack_app")}
                >
                  Workspace bot (recommended)
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={effectiveKind === "slack_incoming_webhook" ? "default" : "outline"}
                  onClick={() => setKind("slack_incoming_webhook")}
                >
                  Incoming webhook
                </Button>
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="channel-name">Channel name</Label>
            <Input id="channel-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="#alerts" />
          </div>

          {!channel && effectiveKind === "slack_app" ? (
            <>
              {slackConnections.length > 1 ? (
                <div className="space-y-1.5">
                  <Label htmlFor="channel-connection">Slack workspace</Label>
                  <select
                    id="channel-connection"
                    value={effectiveConnectionId ?? ""}
                    onChange={(e) => {
                      setConnectionId(e.target.value);
                      setSelected(null);
                      setSlackChannels(null);
                      setNextCursor(null);
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-[13px]"
                  >
                    {slackConnections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName ?? c.externalAccountLogin ?? c.id}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="channel-search">Slack channel</Label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="channel-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search channels…"
                    className="pl-8"
                  />
                </div>
                {pickerError ? (
                  <div className="py-2 text-xs text-destructive">{pickerError}</div>
                ) : slackChannels === null ? (
                  <div className="space-y-2 py-1">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-8 w-full" />
                    ))}
                  </div>
                ) : slackChannels.length === 0 ? (
                  <div className="py-4 text-center text-xs text-muted-foreground">No channels match.</div>
                ) : (
                  <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
                    {slackChannels.map((ch) => (
                      <li key={ch.id}>
                        <button
                          type="button"
                          onClick={() => pickChannel(ch)}
                          className={`w-full px-3 py-2 text-left hover:bg-secondary/60 ${selected?.id === ch.id ? "bg-secondary" : ""}`}
                        >
                          <span className="flex items-center gap-1.5 text-[13px]">
                            <span className="truncate">#{ch.name}</span>
                            {ch.isPrivate ? (
                              <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
                            ) : null}
                          </span>
                          {ch.isPrivate ? (
                            <span className="block text-[11px] text-muted-foreground">
                              The bot must be invited to private channels.
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {nextCursor ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                    Load more
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
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
          )}

          {!channel && !integrations.loading && !hasSlack ? (
            <p className="text-xs text-muted-foreground">
              <Link href={`/orgs/${orgSlug}/integrations`} className="underline underline-offset-2 hover:text-foreground">
                Connect Slack
              </Link>{" "}
              to post via the workspace bot.
            </p>
          ) : null}

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
