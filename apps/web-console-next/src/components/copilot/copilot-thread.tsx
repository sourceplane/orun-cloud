"use client";

// The copilot dispatch thread (saas-copilot-surface CX3, design §5.2;
// experience repair: saas-dispatch-delight DD2/DD6/DD10/DD12): the DX2 left
// pane rebuilt on the AG-UI engine — streaming markdown, collapsible tool
// cards, visible action chips for client tools, stop + regenerate — all
// Northwind, zero engine CSS. History hydrates from the existing GET; the
// engine's agent owns the run lifecycle; the durable rows stay the truth.
//
// DD2 (one transcript, one order): the fold keeps a SINGLE chronological
// item list — text, tool cards, and errors interleaved by arrival — so the
// final assistant bubble can never render above the tool cards that
// produced it, and the reloaded thread has the same shape as the live one.

import * as React from "react";
import { StatusText } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { CLIENT_TOOL_NAMES } from "@saas/contracts/agui";
import { DispatchDoorAgent } from "./door-agent.js";
import { buildActionHandlers } from "./actions.js";
import {
  Composer,
  JumpToLatest,
  StreamingBubble,
  TranscriptRow,
  WorkingLine,
  type ToolCallView,
  type TranscriptItem,
} from "./transcript.js";
import { useRouter } from "next/navigation";

// The transcript vocabulary lives in transcript.tsx now (shared with the
// session lens). Re-exported here so existing importers and the CX3 fold tests
// keep their single entry point.
export type { ToolCallView, TranscriptItem };

export interface LiveState {
  items: TranscriptItem[];
  streaming: string;
  running: boolean;
  /** Last run-level failure, mirrored as a transcript `error` item (DD6);
   * kept here too so the composer can offer retry without scanning items. */
  error: string | null;
}

export const INITIAL: LiveState = { items: [], streaming: "", running: false, error: null };

/** Fold stock engine events into the thread's render state (pure; tested). */
export function foldEngineEvent(s: LiveState, e: { type: string } & Record<string, unknown>): LiveState {
  switch (e.type) {
    case "RUN_STARTED":
      return { ...s, running: true, error: null };
    case "RUN_FINISHED": {
      // A dangling stream still becomes a durable-looking bubble — text the
      // user watched arrive must not vanish at the finish line.
      const items = s.streaming
        ? [...s.items, { kind: "assistant" as const, id: `fin_${s.items.length}`, text: s.streaming }]
        : s.items;
      return { ...s, items, running: false, streaming: "" };
    }
    case "RUN_ERROR": {
      // DD6: an errored run is a transcript artifact, not a transient banner.
      const message = String(e.message ?? e.code ?? "run failed");
      return {
        ...s,
        running: false,
        streaming: "",
        error: message,
        items: [...s.items, { kind: "error", id: `err_${s.items.length}`, text: message }],
      };
    }
    case "TEXT_MESSAGE_CONTENT":
      return { ...s, streaming: s.streaming + String(e.delta ?? "") };
    case "TEXT_MESSAGE_END":
      return s.streaming
        ? {
            ...s,
            items: [
              ...s.items,
              { kind: "assistant", id: String(e.messageId ?? `m_${s.items.length}`), text: s.streaming },
            ],
            streaming: "",
          }
        : s;
    case "TOOL_CALL_START":
      return {
        ...s,
        items: [
          ...s.items,
          {
            kind: "tool",
            id: String(e.toolCallId),
            tool: {
              id: String(e.toolCallId),
              name: String(e.toolCallName ?? "tool"),
              args: "",
              client: CLIENT_TOOL_NAMES.has(String(e.toolCallName ?? "")),
            },
          },
        ],
      };
    case "TOOL_CALL_ARGS":
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === "tool" && it.id === e.toolCallId
            ? { ...it, tool: { ...it.tool, args: it.tool.args + String(e.delta ?? "") } }
            : it,
        ),
      };
    case "TOOL_CALL_RESULT":
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === "tool" && it.id === e.toolCallId
            ? { ...it, tool: { ...it.tool, result: String(e.content ?? ""), ...(e.isError ? { isError: true } : {}) } }
            : it,
        ),
      };
    default:
      return s;
  }
}

/** Rebuild the transcript from durable rows (DD2): tool rows become cards
 * (call+result paired by name), text rows become bubbles, and an assistant
 * turn that produced no text renders as a quiet note — a persisted user
 * message never renders without a following item. */
export function historyToItems(
  messages: Array<{
    seq: number;
    role: string;
    text: string;
    error?: boolean;
    tool?: { name: string; phase: "call" | "result"; summary: string; isError?: boolean };
  }>,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const openTools = new Map<string, number>(); // tool name → items index awaiting result
  for (const m of messages) {
    if (m.tool) {
      if (m.tool.phase === "call") {
        openTools.set(m.tool.name, items.length);
        items.push({
          kind: "tool",
          id: `h${m.seq}`,
          tool: {
            id: `h${m.seq}`,
            name: m.tool.name,
            args: m.tool.summary ?? "",
            client: CLIENT_TOOL_NAMES.has(m.tool.name),
          },
        });
      } else {
        const at = openTools.get(m.tool.name);
        if (at !== undefined) {
          openTools.delete(m.tool.name);
          const it = items[at];
          if (it?.kind === "tool") {
            items[at] = {
              ...it,
              tool: { ...it.tool, result: m.tool.summary ?? "", ...(m.tool.isError ? { isError: true } : {}) },
            };
          }
        } else {
          items.push({
            kind: "tool",
            id: `h${m.seq}`,
            tool: {
              id: `h${m.seq}`,
              name: m.tool.name,
              args: "",
              result: m.tool.summary ?? "",
              ...(m.tool.isError ? { isError: true } : {}),
              client: CLIENT_TOOL_NAMES.has(m.tool.name),
            },
          });
        }
      }
      continue;
    }
    if (m.role === "user") {
      items.push({ kind: "user", id: `h${m.seq}`, text: m.text });
    } else if (m.role === "assistant") {
      if (m.text) {
        items.push({ kind: "assistant", id: `h${m.seq}`, text: m.text, ...(m.error ? { error: true } : {}) });
      } else {
        items.push({ kind: "note", id: `h${m.seq}`, text: "This turn produced no text — see the tool results above." });
      }
    }
  }
  return items;
}

export function CopilotThread({ orgId, orgSlug, chatId }: { orgId: string; orgSlug: string; chatId: string }) {
  const { client, target, token } = useSession();
  const router = useRouter();
  const chat = useApiQuery(qk.orgAgentChat(orgId, chatId), () => wrap(async () => client.agents.getChat(orgId, chatId)));

  const [live, setLive] = React.useState<LiveState>(INITIAL);
  const [composer, setComposer] = React.useState("");
  const [following, setFollowing] = React.useState(true);
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const agentRef = React.useRef<DispatchDoorAgent | null>(null);
  const lastUserRef = React.useRef<string>("");
  // DD10: the double-send guard must be synchronous — React state lags the
  // second Enter; a ref flipped before the POST cannot.
  const sendingRef = React.useRef(false);

  const agent = React.useMemo(() => {
    if (!token) return null;
    const handlers = buildActionHandlers({
      push: (r) => router.push(r),
      orgSlug,
      copy: (t) => navigator.clipboard.writeText(t),
    });
    const a = new DispatchDoorAgent({ target: target.url, token, orgId, chatId, handlers });
    agentRef.current = a;
    return a;
  }, [target.url, token, orgId, chatId, orgSlug, router]);

  const send = React.useCallback(
    async (text: string) => {
      if (!agent || !text.trim() || sendingRef.current) return;
      sendingRef.current = true;
      lastUserRef.current = text.trim();
      setFollowing(true);
      setLive((s) => ({
        ...s,
        running: true,
        error: null,
        items: [...s.items, { kind: "user", id: `u_${s.items.length}_${text.length}`, text: text.trim() }],
      }));
      setComposer("");
      agent.messages = [{ id: crypto.randomUUID(), role: "user", content: text.trim() }];
      try {
        await agent.runAgent(undefined, {
          onEvent: ({ event }) => setLive((s) => foldEngineEvent(s, event as { type: string } & Record<string, unknown>)),
        });
      } catch (err) {
        const message = (err as Error).message;
        setLive((s) => ({
          ...s,
          running: false,
          error: message,
          items: [...s.items, { kind: "error", id: `err_${s.items.length}`, text: message }],
        }));
      } finally {
        sendingRef.current = false;
      }
    },
    [agent],
  );

  // DD12: follow-scroll — pin to the tail while the viewer is at the bottom;
  // never fight a viewer who scrolled up (they get a "jump to latest" chip).
  React.useEffect(() => {
    if (following) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [live.items.length, live.streaming, following]);

  React.useEffect(() => {
    const onScroll = () => {
      const remaining = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      setFollowing(remaining < 240);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (chat.loading && !chat.data) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (chat.error || !chat.data) return <StatusText tone="error">{chat.error?.message ?? "Thread not found"}</StatusText>;

  const history = historyToItems(chat.data.messages ?? []);
  const retry: (() => void) | undefined = lastUserRef.current
    ? () => {
        void send(lastUserRef.current);
      }
    : undefined;

  return (
    // DD12: reserve the composer's height so no bubble ever renders under it.
    <div className="mx-auto w-full max-w-3xl pb-24">
      {history.map((it) => (
        <TranscriptRow key={it.id} it={it} />
      ))}
      {live.items.map((it) => (
        <TranscriptRow key={it.id} it={it} {...(it.kind === "error" && retry ? { onRetry: retry } : {})} />
      ))}
      {/* DD11: streaming text + turn status announce politely. */}
      <div aria-live="polite">
        {live.streaming ? <StreamingBubble text={live.streaming} /> : null}
        {live.running && !live.streaming ? <WorkingLine label="The Workspace Agent is working…" /> : null}
      </div>
      <div ref={endRef} />

      {!following && (live.running || live.streaming) ? (
        <JumpToLatest
          onClick={() => {
            setFollowing(true);
            endRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
        />
      ) : null}

      <Composer
        value={composer}
        onChange={setComposer}
        onSend={() => void send(composer)}
        ariaLabel="Message the Workspace Agent"
        placeholder={
          live.running
            ? "The agent is answering — you can draft your next message…"
            : "Ask, delegate, steer — the agent can open pages and prefill forms for you…"
        }
        running={live.running}
        onStop={() => agentRef.current?.abortRun()}
        {...(lastUserRef.current
          ? { onRegenerate: () => void send(lastUserRef.current), canRegenerate: true }
          : {})}
      />
    </div>
  );
}
