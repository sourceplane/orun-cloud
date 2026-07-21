// The two AG-UI doors over a ChatThread (saas-copilot-surface CX1, design
// §2): the RUN door (turn = run — the normal turn loop teed into an SSE
// event stream) and the WATCH door (passive follower from a cursor). Both
// work by attaching a VIRTUAL HEAD to the thread — a ConnectionLike whose
// send() runs the chat bridge and writes SSE — so the DO's fan-out path is
// exercised unchanged: no second emission path, no second truth.
//
// Vendor-free module (no `agents` import): jest drives it with the real
// ChatThread + a scripted model, reading the streams end-to-end.

import type { AguiEvent } from "@saas/contracts/agui";
import { chatBridgeInitial, translateChatFrame, type ChatBridgeState, type ChatV1Frame } from "@saas/contracts/agui-bridge";
import type { ChatThread, ConnectionLike } from "./chat-thread.js";

export const AGUI_SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

export function encodeAguiSSE(event: AguiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** A ConnectionLike that folds chat-v1 lines through the bridge into SSE.
 *
 * In `run` mode the head enforces the AG-UI run contract the @ag-ui verifier
 * checks (CX3 fix): the stream MUST begin with RUN_STARTED (so the hello-
 * derived STATE_SNAPSHOT is dropped until then), and RUN_ERROR / RUN_FINISHED
 * are TERMINAL — nothing may follow (so an error turn's RUN_ERROR is not
 * chased by the turn:done RUN_FINISHED). In watch mode neither gate applies:
 * the lens fold tolerates a leading snapshot and spans many runs. */
function bridgeHead(
  id: string,
  initial: ChatBridgeState,
  write: (chunk: string) => void,
  opts?: { run?: boolean },
): ConnectionLike {
  let state = initial;
  let connState: unknown = null;
  let opened = !opts?.run; // run mode: closed until the first RUN_STARTED
  let terminated = false;
  return {
    id,
    send(line: string) {
      if (terminated) return;
      let frame: ChatV1Frame;
      try {
        frame = JSON.parse(line) as ChatV1Frame;
      } catch {
        return;
      }
      const r = translateChatFrame(state, frame);
      state = r.state;
      for (const e of r.events) {
        if (!opened) {
          if (e.type === "RUN_STARTED") opened = true;
          else continue; // drop pre-run dialect events (STATE_SNAPSHOT)
        }
        write(encodeAguiSSE(e));
        if (opts?.run && (e.type === "RUN_ERROR" || e.type === "RUN_FINISHED")) {
          terminated = true; // AG-UI: terminal — nothing follows
          return;
        }
      }
    },
    close() {
      /* stream lifecycle is the door's concern */
    },
    setState(s: unknown) {
      connState = s;
    },
    get state() {
      return connState;
    },
  };
}

/**
 * aguiRunDoor — POST …/agui/run (design §2.1). Attaches a virtual head with
 * replay suppressed (from = latest), fires the turn, and closes the stream on
 * completion. A refusal (`turn_in_progress`, `rate_limited`) becomes
 * RUN_ERROR {code} + RUN_FINISHED — the AG-UI shape of the existing 409/429.
 */
export function aguiRunDoor(
  thread: ChatThread,
  chatId: string,
  runId: string | undefined,
  runTurn: () => Promise<{ ok: boolean; reason?: string }>,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (chunk: string) => void writer.write(encoder.encode(chunk)).catch(() => {});
  const headId = `agui-run:${crypto.randomUUID()}`;
  const head = bridgeHead(headId, chatBridgeInitial(chatId, runId), write, { run: true });

  // Suppress replay: the run stream carries exactly this turn (the DO's
  // history rides the existing GET). Number.MAX_SAFE_INTEGER > any seq.
  thread.connect(head, Number.MAX_SAFE_INTEGER);

  void (async () => {
    try {
      const result = await runTurn();
      if (!result.ok && result.reason) {
        // The refusal path emits no frames through the head — speak it
        // in-dialect. RUN_ERROR may be the first event AND is terminal
        // (no RUN_FINISHED after it), per the AG-UI verifier.
        write(encodeAguiSSE({ v: 1, type: "RUN_ERROR", code: result.reason, message: refusalMessage(result.reason), ...(runId ? { runId } : {}) }));
      }
    } catch {
      write(encodeAguiSSE({ v: 1, type: "RUN_ERROR", code: "internal_error", message: "turn failed" }));
    } finally {
      thread.disconnect(headId);
      void writer.close().catch(() => {});
    }
  })();

  return new Response(readable, { headers: AGUI_SSE_HEADERS });
}

function refusalMessage(reason: string): string {
  switch (reason) {
    case "turn_in_progress":
      return "A turn is already running in this thread";
    case "rate_limited":
      return "This thread hit its turn rate ceiling — wait a moment";
    default:
      return reason;
  }
}

/**
 * aguiWatchDoor — GET …/agui/watch?from= (design §2.3). The same frames every
 * WS head receives, through the bridge, as SSE: hello → replay past `from` →
 * live until the client goes away. Passive followers and read-only embeds.
 */
export function aguiWatchDoor(thread: ChatThread, chatId: string, from: number, signal?: AbortSignal): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (chunk: string) => void writer.write(encoder.encode(chunk)).catch(() => {});
  const headId = `agui-watch:${crypto.randomUUID()}`;
  const head = bridgeHead(headId, chatBridgeInitial(chatId), write);

  thread.connect(head, Number.isFinite(from) ? from : -1);

  const teardown = () => {
    thread.disconnect(headId);
    void writer.close().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) teardown();
    else signal.addEventListener("abort", teardown, { once: true });
  }

  return new Response(readable, { headers: AGUI_SSE_HEADERS });
}
