"use client";

// attach-socket — the console head's transport (saas-agents-native AN2): a
// WebSocket to the api-edge attach facade speaking raw attach-v1 frames, with
// reconnect-and-resume (cursor = highest folded seq) and an SSE fallback when
// the socket cannot establish (a draining KV-class session answers 426; some
// networks eat upgrades). The 5-second poll this replaces is deleted, not
// demoted — with WS + SSE both server-side, a degraded-mode poll no longer
// earns its complexity (design §3).
//
// Deliberately NOT the SDK client: resume is the attach cursor, sync is off
// (the frame protocol is the contract), so `useAgent` would only add a second
// protocol's chatter. A plain socket + this fold is the whole client.
//
// Browser constraint: neither WebSocket nor EventSource can set an
// Authorization header, so the bearer rides an `access_token` query param the
// attach facade accepts on this route only (stripped before forwarding).

import * as React from "react";
import {
  foldAttachFrame,
  initialAttachLiveState,
  type AttachLiveState,
  type LiveFrame,
} from "./attach-live";

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;
/** Consecutive WS failures before the SSE fallback takes over. */
const WS_FAILURES_BEFORE_SSE = 2;

export interface AttachSocketOptions {
  /** api target base, e.g. https://api.example.com (from useSession). */
  target: string;
  token: string | null;
  orgId: string;
  sessionId: string;
  /** Live tail on/off — off tears the transport down (terminal sessions). */
  live: boolean;
  /** Fired when a durable event lands (the caller reloads DB-backed queries). */
  onEvent?: () => void;
}

export interface AttachSocketResult extends AttachLiveState {
  /** "ws" | "sse" | "off" — which carriage the tail is on (for the UI chip). */
  transport: "ws" | "sse" | "off";
}

function attachURL(target: string, orgId: string, sessionId: string, from: number, token: string, ws: boolean): string {
  const base = new URL(target);
  if (ws) base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  base.pathname = `/v1/organizations/${encodeURIComponent(orgId)}/agents/sessions/${encodeURIComponent(sessionId)}/attach`;
  base.search = "";
  base.searchParams.set("from", String(from));
  base.searchParams.set("surface", "console");
  base.searchParams.set("access_token", token);
  return base.toString();
}

/**
 * useAttachSocket folds the session's live frame stream into AttachLiveState.
 * WS first; after WS_FAILURES_BEFORE_SSE consecutive dial failures the SSE
 * feed takes over (same frames, same fold). Either transport reconnects with
 * backoff and resumes from the cursor.
 */
export function useAttachSocket(opts: AttachSocketOptions): AttachSocketResult {
  const { target, token, orgId, sessionId, live, onEvent } = opts;
  const [state, setState] = React.useState<AttachLiveState>(() => initialAttachLiveState());
  const [transport, setTransport] = React.useState<"ws" | "sse" | "off">("off");
  const cursorRef = React.useRef(-1);
  const onEventRef = React.useRef(onEvent);
  onEventRef.current = onEvent;

  React.useEffect(() => {
    if (!live || !token) {
      setTransport("off");
      return;
    }
    let disposed = false;
    let ws: WebSocket | null = null;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wsFailures = 0;
    let attempt = 0;

    const fold = (raw: string) => {
      let frame: LiveFrame;
      try {
        frame = JSON.parse(raw) as LiveFrame;
      } catch {
        return;
      }
      setState((prev) => {
        const next = foldAttachFrame(prev, frame);
        if (next.cursor > prev.cursor) {
          cursorRef.current = next.cursor;
          onEventRef.current?.();
        }
        return next;
      });
    };

    const schedule = (fn: () => void) => {
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(fn, delay);
    };

    const connectSSE = () => {
      if (disposed) return;
      es = new EventSource(attachURL(target, orgId, sessionId, cursorRef.current, token, false));
      es.onopen = () => {
        attempt = 0;
        setTransport("sse");
      };
      es.onmessage = (e) => fold(e.data as string);
      es.onerror = () => {
        es?.close();
        es = null;
        if (!disposed) schedule(connectSSE);
      };
    };

    const connectWS = () => {
      if (disposed) return;
      let opened = false;
      ws = new WebSocket(attachURL(target, orgId, sessionId, cursorRef.current, token, true));
      ws.onopen = () => {
        opened = true;
        wsFailures = 0;
        attempt = 0;
        setTransport("ws");
      };
      ws.onmessage = (e) => fold(String(e.data));
      ws.onclose = () => {
        ws = null;
        if (disposed) return;
        if (!opened) wsFailures += 1;
        if (wsFailures >= WS_FAILURES_BEFORE_SSE) {
          // The socket can't establish here (draining session, hostile
          // middlebox). Same frames over SSE — the server-side fallback.
          schedule(connectSSE);
        } else {
          schedule(connectWS);
        }
      };
      ws.onerror = () => {
        // onclose follows and owns the retry.
      };
    };

    connectWS();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
      es?.close();
      setTransport("off");
    };
  }, [target, token, orgId, sessionId, live]);

  return { ...state, transport };
}
