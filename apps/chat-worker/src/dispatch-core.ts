// dispatch-core — the DispatchIndex's pure core (saas-dispatch DX1),
// one SQLite DO per workspace (`wsdx:<orgId>`), hosted in the UNPRIVILEGED
// chat-worker on purpose (epic decision DD7): the object holds NO authorized
// content — only the viewer-agnostic shell (the fold's cursor watermark +
// section counts) and the attached heads. Every head refolds the Situation
// with its OWN credential through the DX0 facade (DD4); this object just
// tells heads WHEN to bother.
//
// The doorbell generalizes the design's ES-lane feeder (recorded amendment,
// design §2.2): anything that learns the world moved may ring —
//   1. a HEAD that refolded and saw the cursor advance reports it
//      (`situation:report`); the object persists the watermark and fans
//      `situation:invalidate` to every OTHER head — one head's backstop
//      poll becomes everyone's push;
//   2. the chat-worker rings after a Workspace Agent turn (a turn may have
//      spawned/steered — the surface's own actions echo instantly);
//   3. the ES-lane consumer can ring later without changing this object.
//
// Wire: attach-v1-flavored JSON frames, v:1.
//   DO → head: situation:shell (snapshot-first paint) · live ·
//              situation:invalidate {section?, cursor?} · pong
//   head → DO: situation:report {cursor, counts} · ping

import type { ChatStorage, ConnectionLike } from "./chat-thread.js";

const STATE_KEY = "dx:shell";
const CURSOR_RE = /^w(\d+)\.(\d+)$/;

export interface DispatchShell {
  /** The work fold's watermark (`w<coordSeq>.<obsSeq>`), `w0.0` until first report. */
  cursor: string;
  /** Section counts for snapshot-first paint (viewer-agnostic aggregates only). */
  counts: Record<string, number>;
  updatedAt: string | null;
}

/** Parse a `w<coord>.<obs>` watermark; null for anything else. */
export function parseCursor(cursor: string): { coord: number; obs: number } | null {
  const m = CURSOR_RE.exec(cursor);
  if (!m) return null;
  return { coord: Number(m[1]), obs: Number(m[2]) };
}

/** True when `next` is strictly past `prev` in fold order. */
export function cursorAdvances(prev: string, next: string): boolean {
  const a = parseCursor(prev);
  const b = parseCursor(next);
  if (!b) return false;
  if (!a) return true;
  return b.coord > a.coord || (b.coord === a.coord && b.obs > a.obs);
}

/** The pure core (the ChatThread/RelayCore discipline): storage-injectable,
 * connection-like heads, no platform types — jest drives it directly. */
export class DispatchIndexCore {
  private shell: DispatchShell = { cursor: "w0.0", counts: {}, updatedAt: null };
  private heads = new Map<string, ConnectionLike>();

  constructor(private storage: ChatStorage) {}

  async load(): Promise<void> {
    const stored = await this.storage.get<DispatchShell>(STATE_KEY);
    if (stored) this.shell = stored;
  }

  shellState(): DispatchShell {
    return { ...this.shell, counts: { ...this.shell.counts } };
  }

  connect(conn: ConnectionLike): void {
    conn.setState({ role: "dispatch-head" });
    conn.send(this.frame({ t: "situation:shell", ...this.shellState() }));
    conn.send(this.frame({ t: "live" }));
    this.heads.set(conn.id, conn);
  }

  rejoin(conn: ConnectionLike): void {
    if (!this.heads.has(conn.id)) this.heads.set(conn.id, conn);
  }

  disconnect(id: string): void {
    this.heads.delete(id);
  }

  headCount(): number {
    return this.heads.size;
  }

  /** A head reports its latest authorized fold. An advancing watermark is
   * persisted and pushed to every OTHER head (the reporter already has it);
   * a stale or equal report is a no-op — reports are idempotent, so N heads
   * folding concurrently converge without chatter. */
  async report(
    reporterId: string | null,
    cursor: string,
    counts: Record<string, number> | undefined,
    at: string,
  ): Promise<{ advanced: boolean }> {
    if (!cursorAdvances(this.shell.cursor, cursor)) return { advanced: false };
    this.shell = {
      cursor,
      counts: counts ? { ...counts } : this.shell.counts,
      updatedAt: at,
    };
    await this.storage.put(STATE_KEY, this.shell);
    this.fanOut({ t: "situation:invalidate", cursor }, reporterId);
    return { advanced: true };
  }

  /** A worker-side doorbell (chat turn, later the ES-lane consumer): no
   * watermark of its own — every head is told to refold the section (or all),
   * and their reports advance the shell. */
  ring(section: string | undefined, at: string): void {
    this.shell = { ...this.shell, updatedAt: at };
    this.fanOut({ t: "situation:invalidate", ...(section ? { section } : {}) }, null);
  }

  /** One inbound head frame. Unknown frames are ignored (forward compat). */
  async handleMessage(conn: ConnectionLike, raw: string, at: string): Promise<void> {
    let msg: { t?: string; cursor?: string; counts?: Record<string, number> };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (msg.t === "ping") {
      conn.send(this.frame({ t: "pong" }));
      return;
    }
    if (msg.t === "situation:report" && typeof msg.cursor === "string") {
      await this.report(conn.id, msg.cursor, msg.counts, at);
    }
  }

  private frame(obj: Record<string, unknown>): string {
    return JSON.stringify({ v: 1, ...obj });
  }

  private fanOut(obj: Record<string, unknown>, exceptId: string | null): void {
    const line = this.frame(obj);
    for (const h of this.heads.values()) {
      if (exceptId !== null && h.id === exceptId) continue;
      try {
        h.send(line);
      } catch {
        // A dead socket leaves via onClose.
      }
    }
  }
}
