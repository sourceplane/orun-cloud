"use client";

// The Workspace Agent chat surface (saas-agents-native AN4 → saas-copilot-surface):
// thread list + thread view. The thread view is the copilot cockpit — streaming
// markdown, tool cards, agent actions — rendered by CopilotThread over the AG-UI
// run door; the durable rows stay the truth. The legacy native chat socket has
// been decommissioned: the cockpit is the one and only chat surface.

import * as React from "react";
import Link from "next/link";
import type { AgentChatSummary } from "@saas/sdk";
import { Skeleton } from "@/components/ui/skeleton";
import { Breadcrumbs, Kicker, PageHeader, Screen, StatusText } from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { compactAge } from "@/lib/agents/attention";
import { CopilotThread } from "@/components/copilot/copilot-thread";

export function WorkspaceChatThread({ orgId, orgSlug, chatId }: { orgId: string; orgSlug: string; chatId: string }) {
  const { client } = useSession();
  const chat = useApiQuery(qk.orgAgentChat(orgId, chatId), () =>
    wrap(async () => client.agents.getChat(orgId, chatId)),
  );

  if (chat.loading && !chat.data) {
    return (
      <Screen>
        <Skeleton className="h-64 w-full rounded-xl" />
      </Screen>
    );
  }
  if (chat.error || !chat.data) {
    return (
      <Screen>
        <StatusText tone="error">{chat.error?.message ?? "Thread not found"}</StatusText>
      </Screen>
    );
  }

  return (
    <Screen>
      <Breadcrumbs
        items={[
          { label: "Agents", href: `/orgs/${orgSlug}/agents` },
          { label: "Chat", href: `/orgs/${orgSlug}/agents/chat` },
          { label: chat.data.title },
        ]}
      />
      <PageHeader
        title={chat.data.title}
        description="The Workspace Agent reads the workspace through governed tools; execution stays in orun sessions."
      />
      <CopilotThread orgId={orgId} orgSlug={orgSlug} chatId={chatId} />
    </Screen>
  );
}

function ThreadRow({
  chat,
  orgSlug,
  onRename,
  onDelete,
}: {
  chat: AgentChatSummary;
  orgSlug: string;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(chat.title);
  const [busy, setBusy] = React.useState(false);

  const commit = async () => {
    const title = draft.trim();
    setEditing(false);
    if (!title || title === chat.title) return;
    setBusy(true);
    try {
      await onRename(chat.id, title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group flex items-center gap-3 border-t border-border/50 px-4 py-2.5 first:border-t-0 hover:bg-muted">
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") {
              setDraft(chat.title);
              setEditing(false);
            }
          }}
          aria-label="Thread title"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-0.5 text-[13.5px] outline-none"
        />
      ) : (
        <Link
          href={`/orgs/${orgSlug}/agents/chat/${chat.id}`}
          title={chat.id}
          className="min-w-0 flex-1 truncate text-[13.5px] font-medium"
        >
          {chat.title}
        </Link>
      )}
      {/* DD3: the raw ch_… id is metadata (title tooltip), never the label —
          the row's secondary line is when the thread last moved. */}
      <span className="whitespace-nowrap text-[11.5px] text-muted-foreground">
        {chat.lastAt ? `${compactAge(chat.lastAt, new Date())} ago` : ""}
      </span>
      <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={() => setEditing(true)}
          disabled={busy}
          aria-label={`Rename thread ${chat.title}`}
          title="Rename"
          className="rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-background"
        >
          ✎
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete "${chat.title}"? The thread and its history are removed everywhere.`)) {
              void onDelete(chat.id);
            }
          }}
          disabled={busy}
          aria-label={`Delete thread ${chat.title}`}
          title="Delete"
          className="rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-background hover:text-destructive"
        >
          ✕
        </button>
      </span>
    </div>
  );
}

export function WorkspaceChatList({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const chats = useApiQuery(qk.orgAgentChats(orgId), () => wrap(async () => client.agents.listChats(orgId)));
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const reload = chats.reload;

  const onCreate = React.useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const chat = await client.agents.createChat(orgId, {});
      window.location.href = `/orgs/${orgSlug}/agents/chat/${chat.id}`;
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to start a thread");
      setCreating(false);
      reload();
    }
  }, [client, orgId, orgSlug, reload]);

  const onRename = React.useCallback(
    async (id: string, title: string) => {
      try {
        await client.agents.renameChat(orgId, id, title);
      } finally {
        reload();
      }
    },
    [client, orgId, reload],
  );

  const onDelete = React.useCallback(
    async (id: string) => {
      try {
        await client.agents.deleteChat(orgId, id);
      } finally {
        reload();
      }
    },
    [client, orgId, reload],
  );

  return (
    <Screen>
      <Breadcrumbs items={[{ label: "Agents", href: `/orgs/${orgSlug}/agents` }, { label: "Chat" }]} />
      <PageHeader
        title="Workspace Agent"
        description="A durable conversational orchestrator: it knows the workspace, plans, and routes execution into governed sessions."
        actions={
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={creating}
            className="rounded-lg bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "Starting…" : "New thread"}
          </button>
        }
      />
      {createError ? <StatusText tone="error">{createError}</StatusText> : null}
      <Kicker className="mb-2.5">Threads</Kicker>
      {chats.loading && !chats.data ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : (chats.data?.length ?? 0) === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No threads yet — start one and ask what broke overnight.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60">
          {(chats.data as AgentChatSummary[]).map((c) => (
            <ThreadRow key={c.id} chat={c} orgSlug={orgSlug} onRename={onRename} onDelete={onDelete} />
          ))}
        </div>
      )}
    </Screen>
  );
}
