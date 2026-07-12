"use client";

// Session detail (saas-agents AG7): infrastructure facts + the relayed event
// feed. The feed is the control-plane MIRROR of the runtime's session log —
// the sealed AgentSessionSnapshot in orun's object graph stays the system of
// record. Polls while the session is live; the DO/SSE live tail replaces the
// poll in a later slice.

import * as React from "react";
import Link from "next/link";
import { isTerminalSessionState } from "@saas/contracts/agents";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Breadcrumbs,
  Kicker,
  PageHeader,
  Pill,
  Screen,
  StatCard,
  StatusText,
} from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { sessionLabel, sessionTone } from "@/lib/agents/model";
import { ConversationView } from "@/components/agents/conversation-view";
import type { ConversationEvent, PendingApproval } from "@/lib/agents/conversation";

const LIVE_POLL_MS = 5_000;

/** ContinueInTerminal renders the copy-the-attach-command handoff — the same
 * session, driven from a terminal head (interchangeable with this console
 * head). */
function ContinueInTerminal({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = React.useState(false);
  const cmd = `orun agent attach ${sessionId}`;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
      <span className="text-[12px] text-muted-foreground">Continue in terminal:</span>
      <code className="font-mono text-[12px]">{cmd}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(cmd).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          );
        }}
        className="ml-auto rounded-md border border-border px-2 py-0.5 text-[11.5px] hover:bg-muted"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function SessionDetail({
  orgId,
  orgSlug,
  sessionId,
}: {
  orgId: string;
  orgSlug: string;
  sessionId: string;
}) {
  const { client } = useSession();
  const session = useApiQuery(qk.orgAgentSession(orgId, sessionId), () =>
    wrap(async () => client.agents.getSession(orgId, sessionId)),
  );
  const events = useApiQuery(qk.orgAgentSessionEvents(orgId, sessionId), () =>
    wrap(async () => client.agents.listSessionEvents(orgId, sessionId)),
  );
  // The children strip (AF4): direct children of this session, live state
  // from the tree columns (the parent's own sealed child_* events carry the
  // narrative in the conversation).
  const children = useApiQuery(qk.orgAgentSessionChildren(orgId, sessionId), () =>
    wrap(async () => {
      const all = await client.agents.listSessions(orgId);
      return all.filter((x) => x.parentSessionId === sessionId);
    }),
  );

  // Poll while live; stop on terminal states. (The SSE live tail over the DO
  // relay replaces the poll when the api-edge attach stream lands — AL8.)
  const live = session.data ? !isTerminalSessionState(session.data.state) : false;
  const reloadSession = session.reload;
  const reloadEvents = events.reload;
  React.useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      reloadSession();
      reloadEvents();
    }, LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [live, reloadSession, reloadEvents]);

  // ── Interactivity (AL7): steer + answer approvals over the relay input
  // route. A fresh ref per send correlates the ack; on success we reload the
  // event feed so the attributed message_user / approval_resolved appears.
  const [composer, setComposer] = React.useState("");
  const [interacting, setInteracting] = React.useState(false);
  const [inputError, setInputError] = React.useState<string | null>(null);
  const refSeq = React.useRef(0);

  const sendFrame = React.useCallback(
    async (frame: Record<string, unknown>) => {
      setInteracting(true);
      setInputError(null);
      try {
        refSeq.current += 1;
        const ack = await client.agents.sendInput(orgId, sessionId, { v: 1, ref: `c-${refSeq.current}`, ...frame });
        if (ack.ok === false) setInputError(`Input rejected: ${ack.reason ?? "unknown"}`);
        reloadEvents();
      } catch (err) {
        setInputError(err instanceof Error ? err.message : "Failed to send");
      } finally {
        setInteracting(false);
      }
    },
    [client, orgId, sessionId, reloadEvents],
  );

  const onSteer = React.useCallback(() => {
    const text = composer.trim();
    if (!text) return;
    setComposer("");
    void sendFrame({ t: "steer", text });
  }, [composer, sendFrame]);

  const onApprove = React.useCallback(
    (a: PendingApproval) => void sendFrame({ t: "verdict", requestId: a.requestId, approved: true }),
    [sendFrame],
  );
  const onDeny = React.useCallback(
    (a: PendingApproval) => void sendFrame({ t: "verdict", requestId: a.requestId, approved: false }),
    [sendFrame],
  );

  // Tree-transitive kill (AF4): cancel this session AND its subtree,
  // children first; the sweep collects any straggler boxes.
  const [killing, setKilling] = React.useState(false);
  const reloadChildren = children.reload;
  const onKill = React.useCallback(async () => {
    setKilling(true);
    setInputError(null);
    try {
      await client.agents.cancelSession(orgId, sessionId);
      reloadSession();
      reloadEvents();
      reloadChildren();
    } catch (err) {
      setInputError(err instanceof Error ? err.message : "Failed to cancel");
    } finally {
      setKilling(false);
    }
  }, [client, orgId, sessionId, reloadSession, reloadEvents, reloadChildren]);

  if (session.loading && !session.data) {
    return (
      <Screen>
        <Skeleton className="h-64 w-full rounded-xl" />
      </Screen>
    );
  }
  if (session.error || !session.data) {
    return (
      <Screen>
        <StatusText tone="error">{session.error?.message ?? "Session not found"}</StatusText>
      </Screen>
    );
  }
  const s = session.data;

  return (
    <Screen>
      <Breadcrumbs
        items={[
          { label: "Agents", href: `/orgs/${orgSlug}/agents` },
          { label: s.id },
        ]}
      />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="font-mono text-[0.85em]">{s.id}</span>
            <Pill tone={sessionTone(s.state)} dot live={s.state === "running"}>
              {sessionLabel(s.state)}
            </Pill>
          </span>
        }
        description={`${s.runKind} run · spawned by ${s.spawnedBy}${s.parentSessionId ? ` · child of ${s.parentSessionId}` : ""}`}
        actions={
          live ? (
            <button
              type="button"
              onClick={() => void onKill()}
              disabled={killing}
              className="rounded-lg border border-destructive/50 px-3 py-1.5 text-[13px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {killing
                ? "Stopping…"
                : (children.data?.length ?? 0) > 0
                  ? "Kill tree"
                  : "Kill session"}
            </button>
          ) : undefined
        }
      />

      {s.failureReason ? (
        <StatusText tone="error" className="mb-4">
          Failure reason: {s.failureReason}
        </StatusText>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Created" value={new Date(s.createdAt).toLocaleString()} />
        <StatCard label="Started" value={s.startedAt ? new Date(s.startedAt).toLocaleString() : "—"} />
        <StatCard label="Ended" value={s.endedAt ? new Date(s.endedAt).toLocaleString() : "—"} />
      </div>

      {(s.taskKey || s.workRef || s.prUrl || s.snapshotId) && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {s.taskKey ? (
            <Link href={`/orgs/${orgSlug}/work`}>
              <Pill tone="info">{s.taskKey}</Pill>
            </Link>
          ) : null}
          {s.prUrl ? (
            <a href={s.prUrl} target="_blank" rel="noreferrer">
              <Pill tone="success">Pull request ↗</Pill>
            </a>
          ) : null}
          {s.snapshotId ? <Pill tone="neutral">sealed {s.snapshotId.slice(0, 18)}…</Pill> : null}
        </div>
      )}

      {/* Handoff (AL8): continue this session in the terminal. Session ids are
          cheap and pasteable — `orun agent attach` works from anywhere your
          identity works, the desktop-app "continue in terminal" move. */}
      {live ? <ContinueInTerminal sessionId={s.id} /> : null}

      {/* The children strip (AF4 §2.2): the delegation tree at a glance. The
          conversation carries the parent's own sealed child_* narrative;
          these rows are the live infrastructure facts. */}
      {(children.data?.length ?? 0) > 0 ? (
        <>
          <Kicker className="mb-2.5 mt-8">
            Children · {children.data!.length}
          </Kicker>
          <div className="overflow-hidden rounded-xl border border-border/60">
            {children.data!.map((c) => (
              <Link
                key={c.id}
                href={`/orgs/${orgSlug}/agents/${c.id}`}
                className="flex items-center gap-2 border-t border-border/50 px-4 py-2.5 first:border-t-0 hover:bg-muted"
              >
                <span className="text-[12px] text-muted-foreground/60">├</span>
                <span className="font-mono text-[12.5px]">{c.id}</span>
                <Pill tone={sessionTone(c.state)} dot live={c.state === "running"}>
                  {sessionLabel(c.state)}
                </Pill>
                <Pill tone="neutral">{c.runKind}</Pill>
                {c.failureReason ? (
                  <span className="truncate text-[12px] text-muted-foreground">{c.failureReason}</span>
                ) : null}
              </Link>
            ))}
          </div>
        </>
      ) : null}

      <Kicker className="mb-2.5 mt-8">Conversation{live ? " · live" : ""}</Kicker>
      {events.loading && !events.data ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : (
        <div className="rounded-xl border border-border/60 p-4">
          <ConversationView
            events={(events.data ?? []) as ConversationEvent[]}
            onApprove={onApprove}
            onDeny={onDeny}
            interacting={interacting}
          />
        </div>
      )}

      {/* Composer — always-on while the session is live. Steering never
          blocks; the turn is attributed to you and sealed into the log. */}
      {live ? (
        <div className="mt-3">
          <div className="flex gap-2">
            <input
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSteer();
                }
              }}
              disabled={interacting}
              placeholder="Message the agent…  (Enter to send)"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-primary disabled:opacity-50"
            />
            <button
              type="button"
              onClick={onSteer}
              disabled={interacting || !composer.trim()}
              className="rounded-lg border border-primary/50 px-3 py-2 text-[13px] text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              Send
            </button>
          </div>
          {inputError ? (
            <StatusText tone="error" className="mt-1.5">
              {inputError}
            </StatusText>
          ) : null}
        </div>
      ) : null}
    </Screen>
  );
}
