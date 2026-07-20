"use client";

// useSituation (saas-dispatch DX2) — the Situation fold + the DX1 live wire.
//
// Data flow: fold via the DX0 facade (authorized per viewer) → report the
// watermark + counts to the workspace's DispatchIndex over WS → any OTHER
// head's advancing report (or a chat-turn ring) arrives as
// `situation:invalidate` → refold. A 30s interval is the degraded-mode
// BACKSTOP, not the hot path (design §2.3): with the socket up, one head's
// backstop discovery becomes everyone's push.

import * as React from "react";
import type { Situation } from "@saas/contracts/dispatch";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { situationCounts } from "./model";

const BACKSTOP_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Collapse invalidation bursts into one refold. */
const INVALIDATE_DEBOUNCE_MS = 250;

function indexSocketURL(target: string, orgId: string, token: string): string {
  const base = new URL(target);
  base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  base.pathname = `/v1/organizations/${encodeURIComponent(orgId)}/dispatch/index`;
  base.search = "";
  base.searchParams.set("access_token", token);
  return base.toString();
}

export interface SituationState {
  situation: Situation | null;
  loading: boolean;
  /** "ws" | "off" — whether the live wire is up (for the UI chip). */
  transport: "ws" | "off";
  reload: () => void;
}

export function useSituation(orgId: string): SituationState {
  const { client, target, token } = useSession();
  const query = useApiQuery(qk.orgDispatchSituation(orgId), () =>
    wrap(async () => client.dispatch.situation(orgId)),
  );
  const [transport, setTransport] = React.useState<"ws" | "off">("off");
  const wsRef = React.useRef<WebSocket | null>(null);
  const reloadRef = React.useRef(query.reload);
  reloadRef.current = query.reload;

  // Report every successful fold's watermark to the rendezvous (fire-and-
  // forget; a closed socket just skips — the backstop still converges).
  const situation = query.data ?? null;
  React.useEffect(() => {
    if (!situation) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          v: 1,
          t: "situation:report",
          cursor: situation.cursor,
          counts: situationCounts(situation),
        }),
      );
    }
  }, [situation]);

  React.useEffect(() => {
    if (!token || !orgId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(indexSocketURL(target.url, orgId, token));
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setTransport("ws");
      };
      ws.onmessage = (e) => {
        let frame: { t?: string };
        try {
          frame = JSON.parse(String(e.data)) as { t?: string };
        } catch {
          return;
        }
        if (frame.t === "situation:invalidate") {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => reloadRef.current(), INVALIDATE_DEBOUNCE_MS);
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        setTransport("off");
        if (disposed) return;
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };
    connect();

    const backstop = setInterval(() => reloadRef.current(), BACKSTOP_MS);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (debounce) clearTimeout(debounce);
      clearInterval(backstop);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [target, token, orgId]);

  return {
    situation,
    loading: query.loading && !query.data,
    transport,
    reload: query.reload,
  };
}
