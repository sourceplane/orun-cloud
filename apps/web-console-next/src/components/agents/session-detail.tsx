"use client";

// Session detail (saas-agents AG7): infrastructure facts + the relayed event
// feed. The feed is the control-plane MIRROR of the runtime's session log —
// the sealed AgentSessionSnapshot in orun's object graph stays the system of
// record. Live tail rides the attach socket (saas-agents-native AN2): WS to
// the api-edge facade, SSE fallback, cursor resume — the 5s poll is gone.

import * as React from "react";
import Link from "next/link";
import { isTerminalSessionState } from "@saas/contracts/agents";
import type { AgentProfile } from "@saas/contracts/agents";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Breadcrumbs,
  Kicker,
  PageHeader,
  Pill,
  Screen,
  StatusText,
} from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { AGENT_MODELS, interfaceTier, sessionLabel, sessionTone } from "@/lib/agents/model";
import { OriginChipView } from "@/components/agents/origin-chip";
import { compactTokens } from "@/lib/agents/attention";
import { humanizeDurationMs } from "@/lib/dispatch/model";
import type { ConversationEvent } from "@/lib/agents/conversation";
import { useAttachSocket } from "@/lib/agents/attach-socket";
import { SessionLens, reconcilePendingSteers } from "@/components/copilot/session-lens";
import { Composer } from "@/components/copilot/transcript";

function modelLabel(model: string): string {
  return AGENT_MODELS.find((m) => m.value === model)?.label ?? model;
}

/** Translate a relay ack reason into a human, actionable line. The wire reasons
 * ("no_consumer", "terminal") are honest but meaningless to a person; a steer
 * that failed needs to tell the user what to do next. Your message is always
 * kept, so every branch says so. */
function steerFailureMessage(reason?: string): string {
  switch (reason) {
    case "no_consumer":
      // Queued but nothing drained it — the runtime isn't reading input yet.
      return "The agent isn't listening yet — it may still be starting up. Your message was kept; try again in a moment.";
    case "terminal":
      return "This session has ended, so steering is no longer possible. Your message was kept.";
    case "not_pending":
      return "That request is no longer waiting on you. Your message was kept.";
    case "control_held":
      // SV5: a human holds control, so the dispatcher's steer was refused.
      return "A human holds control of this implementer — the dispatcher observes only until control is returned.";
    default:
      return "Couldn't deliver your message to the agent. It was kept — try again.";
  }
}

/** A right-rail section: kicker + content. */
function RailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Kicker className="mb-2">{title}</Kicker>
      {children}
    </div>
  );
}

/** A label/value row for the INFRASTRUCTURE + ARTIFACTS rails. */
function RailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[12.5px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{value}</span>
    </div>
  );
}

/** Parse a PR number out of a GitHub-ish PR url for the compact "#495" label. */
function prNumber(url: string): string {
  const m = url.match(/\/pull\/(\d+)/) ?? url.match(/\/pulls\/(\d+)/);
  return m ? `#${m[1]}` : "PR ↗";
}

/** Minutes a session may sit pre-dial-home before the notice names it a likely
 * stall — well before the ~30-min provisioning-stall sweep reclaims it. */
const PROVISION_WARN_MIN = 5;

/** DD5: a principal id is metadata — compact it ("usr_d5c8bd…88e5e") instead
 * of dumping 36 opaque characters into a sentence a human reads. */
function shortPrincipal(id: string): string {
  if (id.length <= 16) return id;
  return `${id.slice(0, 10)}…${id.slice(-5)}`;
}

/**
 * The pre-dial-home notice (requested + provisioning). Before AL: the page went
 * silent the moment state left `requested` — the longer a boot hung, the less
 * the UI said. This keeps a live banner up through `provisioning`, counts the
 * minutes, and past PROVISION_WARN_MIN names the likely stall (the sandbox
 * booted but the runtime never dialed home) instead of leaving a mystery until
 * the sweep. Re-renders on the session poll, so the clock advances on its own.
 */
function ProvisioningNotice({ state, since, orgSlug }: { state: string; since: string; orgSlug: string }) {
  const startedMs = new Date(since).getTime();
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
  const elapsedMin = Math.floor(elapsedMs / 60_000);
  const stalled = elapsedMin >= PROVISION_WARN_MIN;
  // DD4: humane durations — "19 h", never "1163m".
  const elapsedLabel = elapsedMin < 1 ? "just now" : humanizeDurationMs(elapsedMs);

  const message = stalled
    ? `Still ${state} after ${elapsedLabel}. ${
        state === "requested"
          ? "No sandbox was ever created — the spawn found no usable compute provider."
          : "The sandbox was created but the runtime has not dialed home — it may be failing to start."
      } A stalled session is reclaimed automatically ~30 m after spawn; you can also kill it now.`
    : state === "requested"
      ? "Waiting to provision the sandbox on your connected compute — the run starts once the box dials home."
      : `Provisioning the sandbox and starting the runtime · ${elapsedLabel} — the run starts once it dials home.`;

  // A run only boots (and only then becomes chattable) once the workspace has
  // a verified compute + model provider. When `requested` sticks — the boot was
  // gated on a missing/unverified connection — point at the lever directly
  // instead of leaving the "waiting…" line to imply the box is on its way.
  const showConnectionHint = state === "requested";

  return (
    <div
      className={
        stalled
          ? "mt-4 rounded-lg border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-300"
          : "mt-4 rounded-lg border border-border/60 px-3 py-2 text-[12.5px] text-muted-foreground"
      }
    >
      {message}
      {showConnectionHint ? (
        <div className="mt-1.5">
          A run only boots once a compute provider (Daytona) and a model provider are connected and
          verified.{" "}
          <Link href={`/orgs/${orgSlug}/integrations`} className="underline underline-offset-2">
            Check provider connections →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

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
  const { client, target, token } = useSession();
  const session = useApiQuery(qk.orgAgentSession(orgId, sessionId), () =>
    wrap(async () => client.agents.getSession(orgId, sessionId)),
  );
  const events = useApiQuery(qk.orgAgentSessionEvents(orgId, sessionId), () =>
    wrap(async () => client.agents.listSessionEvents(orgId, sessionId)),
  );
  // Profiles back the INFRASTRUCTURE rail (type/harness/model/autonomy); a
  // failure degrades to the raw profile id, never blanks the page.
  const profiles = useApiQuery(qk.orgAgentProfiles(orgId), () =>
    wrap(async () => client.agents.listProfiles(orgId).catch(() => [] as AgentProfile[])),
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

  // The live tail (AN2): the attach socket streams the relayed frames —
  // events fold straight into the conversation below, deltas render as the
  // in-progress line, presence fills the Heads rail. The poll is deleted, not
  // demoted (WS with server-side SSE fallback is the whole transport story).
  const live = session.data ? !isTerminalSessionState(session.data.state) : false;
  const reloadSession = session.reload;
  const reloadEvents = events.reload;
  const tail = useAttachSocket({ target: target.url, token, orgId, sessionId, live });

  // The conversation = the durable DB read + everything the socket folded past
  // it, deduped by seq. Memoized so the optimistic-steer reconcile below (and
  // the transcript render) key off a stable identity.
  const mergedEvents = React.useMemo<ConversationEvent[]>(() => {
    const dbEvents = (events.data ?? []) as ConversationEvent[];
    const maxDbSeq = dbEvents.reduce((m, e) => Math.max(m, (e as { seq?: number }).seq ?? -1), -1);
    return [...dbEvents, ...tail.events.filter((e) => e.seq > maxDbSeq)] as ConversationEvent[];
  }, [events.data, tail.events]);

  // A relayed state change (or the terminal bye) refreshes the session row —
  // the pill, the artifacts rail, and `live` itself follow the DB truth.
  const tailState = tail.sessionState;
  const tailEnded = tail.ended;
  React.useEffect(() => {
    if (tailState || tailEnded) reloadSession();
  }, [tailState, tailEnded, reloadSession]);

  // Liveness safety net (AN2 hardening). The attach socket pushes instant
  // updates when it can establish — but control-plane transitions
  // (requested → provisioning → running) ride the DB, NOT the runtime stream,
  // and some networks eat the WS/SSE upgrade entirely, so nothing lands until a
  // manual refresh. While the session is live, poll the session row and the
  // event log every few seconds so the state pill, the cost, and the
  // conversation stay current with no refresh; the socket still delivers
  // instant token streaming when it's available. Refs keep the interval stable
  // across renders; a hidden tab pauses to spare the API.
  const reloadSessionRef = React.useRef(reloadSession);
  reloadSessionRef.current = reloadSession;
  const reloadEventsRef = React.useRef(reloadEvents);
  reloadEventsRef.current = reloadEvents;
  React.useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      reloadSessionRef.current();
      reloadEventsRef.current();
    }, 2500);
    return () => clearInterval(id);
  }, [live]);

  // ── Interactivity (AL7): steer + answer approvals over the relay input
  // route. A fresh ref per send correlates the ack; on success we reload the
  // event feed so the attributed message_user / approval_resolved appears.
  const [composer, setComposer] = React.useState("");
  const [interacting, setInteracting] = React.useState(false);
  const [inputError, setInputError] = React.useState<string | null>(null);
  const refSeq = React.useRef(0);

  // Optimistic steers (modern-chat responsiveness): the viewer's message shows
  // the instant they hit Send, before the relay echoes the durable
  // `message_user` back. Each carries the seq high-water mark at send time;
  // once a matching durable event lands past it, the optimistic bubble is
  // dropped so it never double-renders.
  const [pendingSteers, setPendingSteers] = React.useState<Array<{ id: string; text: string; sinceSeq: number }>>([]);
  const optSeq = React.useRef(0);
  const maxSeqRef = React.useRef(-1);
  React.useEffect(() => {
    maxSeqRef.current = mergedEvents.reduce((m, e) => Math.max(m, (e as { seq?: number }).seq ?? -1), -1);
    setPendingSteers((prev) => reconcilePendingSteers(prev, mergedEvents));
  }, [mergedEvents]);

  const sendFrame = React.useCallback(
    async (frame: Record<string, unknown>): Promise<boolean> => {
      setInteracting(true);
      setInputError(null);
      try {
        refSeq.current += 1;
        const ack = await client.agents.sendInput(orgId, sessionId, { v: 1, ref: `c-${refSeq.current}`, ...frame });
        if (ack.ok === false) {
          // The relay couldn't deliver it to the running agent. Fail loud —
          // never eat it — and translate the wire reason into something a
          // person can act on (not the raw "no_consumer"/"terminal" token).
          setInputError(steerFailureMessage(ack.reason));
          return false;
        }
        reloadEvents();
        return true;
      } catch (err) {
        setInputError(err instanceof Error ? `${err.message} — your message was kept.` : "Failed to send — your message was kept.");
        return false;
      } finally {
        setInteracting(false);
      }
    },
    [client, orgId, sessionId, reloadEvents],
  );

  const onSteer = React.useCallback(async () => {
    const text = composer.trim();
    if (!text || interacting) return;
    // Optimistic echo: the bubble and the cleared box show immediately, so the
    // send feels instant instead of waiting on the relay round-trip.
    optSeq.current += 1;
    const id = `opt-${optSeq.current}`;
    setPendingSteers((p) => [...p, { id, text, sinceSeq: maxSeqRef.current }]);
    setComposer("");
    const ok = await sendFrame({ t: "steer", text });
    if (!ok) {
      // The relay refused it — roll the bubble back and restore the text so a
      // correction that can't reach the agent never silently vanishes (the AL7
      // silent-eat bug); the error line already says what happened.
      setPendingSteers((p) => p.filter((e) => e.id !== id));
      setComposer(text);
    }
  }, [composer, interacting, sendFrame]);

  const onApproveId = React.useCallback(
    (requestId: string) => void sendFrame({ t: "verdict", requestId, approved: true }),
    [sendFrame],
  );
  const onDenyId = React.useCallback(
    (requestId: string) => void sendFrame({ t: "verdict", requestId, approved: false }),
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

  // Takeover (SV5): Take control → the dispatcher observes only until Return.
  // `held` is optimistic-then-confirmed by the server's control state.
  const [held, setHeld] = React.useState(false);
  const [controlBusy, setControlBusy] = React.useState(false);
  const onToggleControl = React.useCallback(async () => {
    setControlBusy(true);
    setInputError(null);
    try {
      const res = held
        ? await client.agents.returnControl(orgId, sessionId)
        : await client.agents.takeControl(orgId, sessionId);
      setHeld(!!res.control);
      reloadEvents();
    } catch (err) {
      setInputError(err instanceof Error ? err.message : "Failed to change control");
    } finally {
      setControlBusy(false);
    }
  }, [client, orgId, sessionId, held, reloadEvents]);

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
  // The conversation = the durable DB read (initial load) + everything the
  // socket folded past it, deduped by seq. A reconnect replays from the
  // cursor, so the union is gapless without ever re-fetching the log.
  // Is the agent mid-turn? A steer in flight, an optimistic bubble not yet
  // echoed, or a relayed user turn with no agent reply after it — any of these
  // means "working" (until the reply streams). Drives the thinking indicator.
  let lastUserSeq = -1;
  let lastAgentSeq = -1;
  for (const e of mergedEvents) {
    if (e.kind === "message_user") lastUserSeq = Math.max(lastUserSeq, e.seq);
    else if (e.kind === "message_agent") lastAgentSeq = Math.max(lastAgentSeq, e.seq);
  }
  const working = live && (interacting || pendingSteers.length > 0 || lastUserSeq > lastAgentSeq);
  const profile = (profiles.data ?? []).find((p) => p.id === s.profileId);
  const startedLabel = s.startedAt
    ? new Date(s.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
  const createdLabel = new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // DD5: "Interactive run", "Implementation run" — the id stays metadata.
  const runTitle = `${s.runKind.charAt(0).toUpperCase()}${s.runKind.slice(1)} run`;
  const hasArtifacts = !!(s.prUrl || s.snapshotId);

  return (
    <Screen>
      <Breadcrumbs
        items={[
          { label: "Agents", href: `/orgs/${orgSlug}/agents` },
          { label: runTitle },
        ]}
      />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {/* DD5: the human label leads; the raw as_… id is metadata below. */}
            <span>{runTitle}</span>
            <Pill tone={sessionTone(s.state)} dot live={s.state === "running"}>
              {sessionLabel(s.state)}
            </Pill>
            {/* Origin taint (SV0): a deep-linking chip back to whoever set this
                implementer running (thread / work item / parent session). */}
            <OriginChipView origin={s.origin} orgSlug={orgSlug} linked />
          </span>
        }
        description={`${s.id} · spawned by ${shortPrincipal(s.spawnedBy)} · started ${createdLabel}${s.parentSessionId ? ` · child of ${s.parentSessionId}` : ""}`}
        actions={
          live ? (
            <div className="flex items-center gap-2">
              {/* Takeover (SV5): the seat is identical either way — this only
                  changes who the dispatcher defers to. */}
              <button
                type="button"
                onClick={() => void onToggleControl()}
                disabled={controlBusy}
                className="rounded-lg border border-border px-3 py-1.5 text-[13px] hover:bg-muted disabled:opacity-50"
              >
                {controlBusy ? "…" : held ? "Return control" : "Take control"}
              </button>
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
            </div>
          ) : undefined
        }
      />

      {/* Two columns: the conversation head (left), the facts rail (right) —
          the Northwind session-page layout. */}
      <div className="grid grid-cols-1 gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_250px]">
        {/* ── Main column: the head ─────────────────────────────── */}
        <div className="min-w-0">
          {/* Supervised-by banner (SV4): a dispatch-origin implementer is
              supervised by the thread that spawned it — deep-link back. */}
          {s.origin.kind === "dispatch" && s.origin.ref ? (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-[12.5px]">
              <span className="text-muted-foreground">
                Supervised by{" "}
                <span className="font-medium text-foreground">
                  {s.origin.label ?? "the dispatcher thread"}
                </span>
              </span>
              <Link
                href={`/orgs/${orgSlug}/agents/chat/${s.origin.ref}`}
                className="ml-auto shrink-0 font-medium underline underline-offset-2 hover:opacity-80"
              >
                Open thread →
              </Link>
            </div>
          ) : null}

          {s.failureReason ? (
            <StatusText tone="error" className="mb-4">
              Failure reason: {s.failureReason}
            </StatusText>
          ) : null}

          {/* Handoff (AL8): continue this session in the terminal. */}
          {live ? <ContinueInTerminal sessionId={s.id} /> : null}

          {s.state === "requested" || s.state === "provisioning" ? (
            <ProvisioningNotice state={s.state} since={s.createdAt} orgSlug={orgSlug} />
          ) : null}

          {/* The children strip (AF4 §2.2): the delegation tree at a glance. */}
          {(children.data?.length ?? 0) > 0 ? (
            <>
              <Kicker className="mb-2.5 mt-6">Children · {children.data!.length}</Kicker>
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

          <Kicker className="mb-2.5 mt-6">
            Conversation
            {live ? (tail.transport === "off" ? " · live" : ` · live (${tail.transport})`) : ""}
          </Kicker>

          {/* The cockpit head (the one session surface): the SAME transcript
              vocabulary the dispatch thread renders, over the session's AG-UI
              watch door — full replay while live, the durable log once it
              ends. */}
          {events.loading && !events.data && !live ? (
            <Skeleton className="h-48 w-full rounded-xl" />
          ) : (
            <SessionLens
              live={live}
              events={mergedEvents}
              pending={pendingSteers}
              working={working}
              streaming={tail.streaming}
              tokens={s.tokensUsed ?? 0}
              tierLabel={interfaceTier(profile?.interface).label}
              tierTone={interfaceTier(profile?.interface).tone}
              onApprove={onApproveId}
              onDeny={onDenyId}
              interacting={interacting}
              emptyHint={
                live
                  ? "The runtime relays its session log here once the sandbox dials home."
                  : "This session ended without relaying a session log."
              }
            />
          )}

          {/* Composer — always-on while the session is live. Same chrome as the
              dispatch composer; a steer lands in the session log, attributed to
              you. */}
          {live ? (
            <Composer
              value={composer}
              onChange={setComposer}
              onSend={onSteer}
              ariaLabel="Steer the run"
              placeholder="Steer the run — lands in the session log, attributed to you"
              disabled={interacting}
              error={inputError}
            />
          ) : null}
        </div>

        {/* ── Right rail: the facts ─────────────────────────────── */}
        <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
          {s.workRef || s.taskKey ? (
            <RailSection title="Task pointer">
              <div className="rounded-xl border bg-card px-3.5 py-3">
                {s.workRef ? (
                  <div className="truncate font-mono text-[11.5px] text-muted-foreground">{s.workRef}</div>
                ) : null}
                {s.taskKey ? <div className="mt-1 text-[13px] font-medium">{s.taskKey}</div> : null}
                <Link
                  href={`/orgs/${orgSlug}/work`}
                  className="mt-2 inline-block text-[12.5px] text-primary hover:underline"
                >
                  Open in Work →
                </Link>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
                Work truth stays on Work — this session links to it, never restates it.
              </p>
            </RailSection>
          ) : null}

          <RailSection title="Infrastructure">
            <div className="border-t border-border/50">
              <RailRow label="Profile" value={profile?.name ?? s.profileId} />
              {profile?.agentType ? <RailRow label="Type" value={profile.agentType} /> : null}
              {profile?.harness ? <RailRow label="Harness" value={profile.harness} /> : null}
              {profile?.model ? <RailRow label="Model" value={modelLabel(profile.model)} /> : null}
              {profile?.autonomyDefault ? <RailRow label="Autonomy" value={profile.autonomyDefault} /> : null}
              <RailRow label="Started" value={startedLabel} />
              <RailRow label="Cost" value={`${compactTokens(s.tokensUsed)} tokens`} />
            </div>
          </RailSection>

          {hasArtifacts ? (
            <RailSection title="Artifacts">
              <div className="border-t border-border/50">
                {s.prUrl ? (
                  <RailRow
                    label="Pull request"
                    value={
                      <a href={s.prUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        {prNumber(s.prUrl)}
                      </a>
                    }
                  />
                ) : null}
                {s.snapshotId ? <RailRow label="Sealed" value={`${s.snapshotId.slice(0, 12)}…`} /> : null}
              </div>
            </RailSection>
          ) : null}

          <RailSection title="Heads">
            {tail.heads.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {tail.heads.map((h, i) => (
                  <Pill key={`${h.principal}-${h.surface}-${i}`} tone="neutral">
                    {h.principal} · {h.surface}
                  </Pill>
                ))}
              </div>
            ) : null}
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              Console and terminal drive the same session — the sealed session log is the system of
              record.
            </p>
          </RailSection>
        </aside>
      </div>
    </Screen>
  );
}
