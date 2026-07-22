"use client";

// The Workspace Agent chat surface (saas-agents-native AN4): thread list +
// thread view. The thread streams over the chat socket (WS to the api-edge
// facade, cursor resume — the same transport idiom as the session head);
// turns POST through the credentialed route. Tool calls render as cards;
// custody failures render as honest, retryable error turns.

import * as React from "react";
import Link from "next/link";
import type { AgentChatMessage, AgentChatSummary } from "@saas/sdk";
import { Skeleton } from "@/components/ui/skeleton";
import { Breadcrumbs, Kicker, PageHeader, Pill, Screen, StatusText } from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import {
  foldChatFrame,
  initialChatLiveState,
  mergeChatMessages,
  type ChatFrame,
  type ChatLiveState,
} from "@/lib/agents/chat-live";
import { compactAge } from "@/lib/agents/attention";
import { CopilotThread } from "@/components/copilot/copilot-thread";
import { useCopilotFlag } from "@/components/copilot/flag";

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;

function chatSocketURL(target: string, orgId: string, chatId: string, from: number, token: string): string {
  const base = new URL(target);
  base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  base.pathname = `/v1/organizations/${encodeURIComponent(orgId)}/agents/chats/${encodeURIComponent(chatId)}`;
  base.search = "";
  base.searchParams.set("from", String(from));
  base.searchParams.set("access_token", token);
  return base.toString();
}

/** The thread's live tail — plain WS + pure fold, reconnect from cursor. */
function useChatSocket(target: string, token: string | null, orgId: string, chatId: string): ChatLiveState {
  const [state, setState] = React.useState<ChatLiveState>(() => initialChatLiveState());
  const cursorRef = React.useRef(-1);

  React.useEffect(() => {
    if (!token || !chatId) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(chatSocketURL(target, orgId, chatId, cursorRef.current, token));
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (e) => {
        let frame: ChatFrame;
        try {
          frame = JSON.parse(String(e.data)) as ChatFrame;
        } catch {
          return;
        }
        setState((prev) => {
          const next = foldChatFrame(prev, frame);
          if (next.cursor > prev.cursor) cursorRef.current = next.cursor;
          return next;
        });
      };
      ws.onclose = () => {
        ws = null;
        if (disposed) return;
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [target, token, orgId, chatId]);

  return state;
}

function MessageRow({ m }: { m: AgentChatMessage }) {
  if (m.tool) {
    return (
      <div className="my-1 rounded-lg border border-border/50 bg-muted/40 px-3 py-1.5 font-mono text-[12px] text-muted-foreground">
        <span className="mr-2">⚙ {m.tool.name}</span>
        <span className={m.tool.isError ? "text-destructive" : ""}>
          {m.tool.phase === "call" ? "…" : m.tool.summary}
        </span>
      </div>
    );
  }
  const mine = m.role === "user";
  return (
    <div className={`my-2 flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={
          mine
            ? "max-w-[80%] rounded-2xl bg-foreground px-3.5 py-2 text-[13.5px] text-background"
            : m.error
              ? "max-w-[80%] rounded-2xl border border-amber-500/50 bg-amber-500/5 px-3.5 py-2 text-[13.5px]"
              : "max-w-[80%] rounded-2xl border border-border/60 px-3.5 py-2 text-[13.5px]"
        }
      >
        <p className="whitespace-pre-wrap">{m.text}</p>
        {mine && m.principal ? (
          <p className="mt-1 text-right text-[10.5px] opacity-60">{m.principal}</p>
        ) : null}
      </div>
    </div>
  );
}

export function WorkspaceChatThread({ orgId, orgSlug, chatId }: { orgId: string; orgSlug: string; chatId: string }) {
  const copilot = useCopilotFlag(orgId);
  const { client, target, token } = useSession();
  const chat = useApiQuery(qk.orgAgentChat(orgId, chatId), () =>
    wrap(async () => client.agents.getChat(orgId, chatId)),
  );
  const live = useChatSocket(target.url, token, orgId, chatId);

  const [composer, setComposer] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement | null>(null);

  const messages = mergeChatMessages(chat.data?.messages ?? [], live.messages);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, live.streaming]);

  const onSend = React.useCallback(async () => {
    const text = composer.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await client.agents.sendChatTurn(orgId, chatId, text);
      if (res.ok === false && res.reason !== "turn_in_progress") {
        // The thread already shows the honest error turn; nothing else to say.
      }
      setComposer("");
    } catch (err) {
      setSendError(err instanceof Error ? `${err.message} — your message was kept.` : "Failed to send — your message was kept.");
    } finally {
      setSending(false);
    }
  }, [composer, sending, client, orgId, chatId]);

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
        title={
          <span className="flex items-center gap-3">
            {live.title ?? chat.data.title}
            {live.turning ? (
              <Pill tone="info" dot live>
                thinking
              </Pill>
            ) : null}
          </span>
        }
        description="The Workspace Agent reads the workspace through governed tools; execution stays in orun sessions."
      />

      {copilot ? (
        <CopilotThread orgId={orgId} orgSlug={orgSlug} chatId={chatId} />
      ) : (
      <div className="mx-auto w-full max-w-3xl">
        {messages.map((m) => (
          <MessageRow key={m.seq} m={m} />
        ))}
        {live.streaming ? (
          <div className="my-2 flex justify-start">
            <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl border border-border/60 px-3.5 py-2 text-[13.5px]">
              {live.streaming}
              <span className="animate-pulse">▍</span>
            </div>
          </div>
        ) : null}
        <div ref={endRef} />

        <div className="sticky bottom-4 mt-6">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-2 py-1.5 shadow-sm focus-within:border-primary">
            <input
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void onSend();
                }
              }}
              disabled={sending}
              placeholder="Ask about the workspace — catalog, runs, work, budgets…"
              className="min-w-0 flex-1 bg-transparent px-2 py-1 text-[13px] outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void onSend()}
              disabled={sending || !composer.trim()}
              className="rounded-lg bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              Send
            </button>
          </div>
          {sendError ? (
            <StatusText tone="error" className="mt-1.5">
              {sendError}
            </StatusText>
          ) : null}
        </div>
      </div>
      )}
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
