"use client";

// The copilot dispatch thread (saas-copilot-surface CX3, design §5.2): the
// DX2 left pane rebuilt on the AG-UI engine — streaming markdown, collapsible
// tool cards, visible action chips for client tools, stop + regenerate — all
// Northwind, zero engine CSS. History hydrates from the existing GET; the
// engine's agent owns the run lifecycle; the durable rows stay the truth.

import * as React from "react";
import ReactMarkdown from "react-markdown";
import { Pill, StatusText } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { CLIENT_TOOL_NAMES } from "@saas/contracts/agui";
import { DispatchDoorAgent } from "./door-agent.js";
import { buildActionHandlers } from "./actions.js";
import { useRouter } from "next/navigation";

interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  error?: boolean;
}

interface ToolCallView {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
  client: boolean;
}

interface LiveState {
  messages: ThreadMessage[];
  tools: ToolCallView[];
  streaming: string;
  running: boolean;
  error: string | null;
}

const INITIAL: LiveState = { messages: [], tools: [], streaming: "", running: false, error: null };

/** Fold stock engine events into the thread's render state (pure; tested). */
export function foldEngineEvent(s: LiveState, e: { type: string } & Record<string, unknown>): LiveState {
  switch (e.type) {
    case "RUN_STARTED":
      return { ...s, running: true, error: null };
    case "RUN_FINISHED":
      return { ...s, running: false, streaming: "" };
    case "RUN_ERROR":
      return { ...s, running: false, streaming: "", error: String(e.message ?? e.code ?? "run failed") };
    case "TEXT_MESSAGE_CONTENT":
      return { ...s, streaming: s.streaming + String(e.delta ?? "") };
    case "TEXT_MESSAGE_END":
      return s.streaming
        ? { ...s, messages: [...s.messages, { id: String(e.messageId ?? crypto.randomUUID()), role: "assistant", text: s.streaming }], streaming: "" }
        : s;
    case "TOOL_CALL_START":
      return {
        ...s,
        tools: [
          ...s.tools,
          {
            id: String(e.toolCallId),
            name: String(e.toolCallName ?? "tool"),
            args: "",
            client: CLIENT_TOOL_NAMES.has(String(e.toolCallName ?? "")),
          },
        ],
      };
    case "TOOL_CALL_ARGS":
      return {
        ...s,
        tools: s.tools.map((t) => (t.id === e.toolCallId ? { ...t, args: t.args + String(e.delta ?? "") } : t)),
      };
    case "TOOL_CALL_RESULT":
      return {
        ...s,
        tools: s.tools.map((t) =>
          t.id === e.toolCallId ? { ...t, result: String(e.content ?? ""), ...(e.isError ? { isError: true } : {}) } : t,
        ),
      };
    default:
      return s;
  }
}

function ToolCard({ t }: { t: ToolCallView }) {
  const [open, setOpen] = React.useState(false);
  if (t.client) {
    // The agent's hands are always on camera (design §3.3).
    return (
      <div className="my-1 flex items-center gap-2 text-[12px]">
        <Pill tone={t.isError ? "warning" : "info"} dot>
          {t.name.replace(/^ui_/, "").replace(/_/g, " ")}
        </Pill>
        {t.result ? <span className="text-muted-foreground">{t.result}</span> : <span className="animate-pulse text-muted-foreground">…</span>}
      </div>
    );
  }
  return (
    <div className="my-1 rounded-lg border border-border/50 bg-muted/40 text-[12px]">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-muted-foreground">
        <span>⚙ {t.name}</span>
        <span className={t.isError ? "text-destructive" : ""}>{t.result === undefined ? "…" : t.isError ? "failed" : "done"}</span>
        <span className="ml-auto text-[10px]">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="border-t border-border/50 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <div className="truncate">args: {t.args || "{}"}</div>
          {t.result !== undefined ? <div className="mt-1 whitespace-pre-wrap break-words">{t.result}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Bubble({ m }: { m: ThreadMessage }) {
  const mine = m.role === "user";
  if (mine) {
    return (
      <div className="my-2 flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-foreground px-3.5 py-2 text-[13.5px] text-background">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="my-2 flex justify-start">
      <div className={`prose-chat max-w-[80%] rounded-2xl border px-3.5 py-2 text-[13.5px] ${m.error ? "border-amber-500/50 bg-amber-500/5" : "border-border/60"}`}>
        <ReactMarkdown>{m.text}</ReactMarkdown>
      </div>
    </div>
  );
}

export function CopilotThread({ orgId, orgSlug, chatId }: { orgId: string; orgSlug: string; chatId: string }) {
  const { client, target, token } = useSession();
  const router = useRouter();
  const chat = useApiQuery(qk.orgAgentChat(orgId, chatId), () => wrap(async () => client.agents.getChat(orgId, chatId)));

  const [live, setLive] = React.useState<LiveState>(INITIAL);
  const [composer, setComposer] = React.useState("");
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const agentRef = React.useRef<DispatchDoorAgent | null>(null);
  const lastUserRef = React.useRef<string>("");

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
      if (!agent || !text.trim() || live.running) return;
      lastUserRef.current = text.trim();
      setLive((s) => ({ ...s, messages: [...s.messages, { id: crypto.randomUUID(), role: "user", text: text.trim() }], tools: [] }));
      setComposer("");
      agent.messages = [{ id: crypto.randomUUID(), role: "user", content: text.trim() }];
      try {
        await agent.runAgent(undefined, {
          onEvent: ({ event }) => setLive((s) => foldEngineEvent(s, event as { type: string } & Record<string, unknown>)),
        });
      } catch (err) {
        setLive((s) => ({ ...s, running: false, error: (err as Error).message }));
      }
    },
    [agent, live.running],
  );

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [live.messages.length, live.streaming, live.tools.length]);

  if (chat.loading && !chat.data) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (chat.error || !chat.data) return <StatusText tone="error">{chat.error?.message ?? "Thread not found"}</StatusText>;

  const history: ThreadMessage[] = (chat.data.messages ?? [])
    .filter((m) => !m.tool && (m.role === "user" || m.role === "assistant") && m.text)
    .map((m) => ({ id: `h${m.seq}`, role: m.role as "user" | "assistant", text: m.text, ...(m.error ? { error: true } : {}) }));

  return (
    <div className="mx-auto w-full max-w-3xl">
      {history.map((m) => (
        <Bubble key={m.id} m={m} />
      ))}
      {live.messages.map((m) => (
        <Bubble key={m.id} m={m} />
      ))}
      {live.tools.map((t) => (
        <ToolCard key={t.id} t={t} />
      ))}
      {live.streaming ? (
        <div className="my-2 flex justify-start">
          <div className="prose-chat max-w-[80%] rounded-2xl border border-border/60 px-3.5 py-2 text-[13.5px]">
            <ReactMarkdown>{live.streaming}</ReactMarkdown>
            <span className="animate-pulse">▍</span>
          </div>
        </div>
      ) : null}
      {live.error ? (
        <StatusText tone="error" className="my-2">
          {live.error}
        </StatusText>
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
                void send(composer);
              }
            }}
            disabled={live.running}
            placeholder="Ask, delegate, steer — the agent can open pages and prefill forms for you…"
            className="min-w-0 flex-1 bg-transparent px-2 py-1 text-[13px] outline-none disabled:opacity-50"
          />
          {live.running ? (
            <button
              type="button"
              onClick={() => agentRef.current?.abortRun()}
              className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] hover:bg-muted"
            >
              Stop
            </button>
          ) : (
            <>
              {lastUserRef.current ? (
                <button
                  type="button"
                  onClick={() => void send(lastUserRef.current)}
                  title="Regenerate the last answer"
                  className="rounded-lg px-2 py-1.5 text-[12.5px] text-muted-foreground hover:bg-muted"
                >
                  ↻
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void send(composer)}
                disabled={!composer.trim()}
                className="rounded-lg bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                Send
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
