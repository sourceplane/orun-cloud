// DispatchDoorAgent (saas-copilot-surface CX3, design §5.1): the AG-UI
// engine's agent object bound to the platform's run door. The Durable Object
// remains the only author of turns (lock 1) — this class just POSTs a
// RunAgentInput, folds the door's SSE dialect into stock events, and runs
// the CX2 client-tool side channel (execute the handler with the VIEWER's
// session, post the result back so the paused server turn resumes).
//
// This is the vendor seam (lock 8): the same object plugs into CopilotKit's
// `selfManagedAgents` unchanged, or is driven headless (copilot-thread.tsx).

import { AbstractAgent } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { Observable, type Subscriber } from "rxjs";
import { CLIENT_TOOLS_V1 } from "@saas/contracts/agui";
import { createClientCallTracker, createSSEParser, mapDoorEvent } from "./door-events.js";
import type { ActionHandler } from "./actions.js";

export interface DoorAgentConfig {
  /** api target base (from useSession), e.g. https://api.example.com */
  target: string;
  token: string;
  orgId: string;
  chatId: string;
  handlers: Record<string, ActionHandler>;
  fetchFn?: typeof fetch;
}

export class DispatchDoorAgent extends AbstractAgent {
  private cfg: DoorAgentConfig;

  constructor(cfg: DoorAgentConfig) {
    super({ agentId: `dispatch:${cfg.chatId}`, description: "Workspace Agent (dispatch)" });
    this.cfg = cfg;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((sub) => {
      const abort = new AbortController();
      void this.pump(input, sub, abort.signal);
      return () => abort.abort();
    });
  }

  private doorURL(path: string): string {
    const { target, orgId, chatId } = this.cfg;
    return `${target.replace(/\/+$/, "")}/v1/organizations/${encodeURIComponent(orgId)}/agents/chats/${encodeURIComponent(chatId)}${path}`;
  }

  private async pump(input: RunAgentInput, sub: Subscriber<BaseEvent>, signal: AbortSignal): Promise<void> {
    const doFetch = this.cfg.fetchFn ?? fetch;
    try {
      const res = await doFetch(this.doorURL("/agui/run"), {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${this.cfg.token}`,
        },
        body: JSON.stringify({
          threadId: input.threadId,
          runId: input.runId,
          messages: (input.messages ?? []).map((m) => ({
            role: m.role,
            content: typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content : "",
          })),
          // Surface-aware advertisement (DD7): only registry verbs the
          // mounted surface registered a handler for. The door still
          // validates against the registry and the DO's copy defines the
          // specs (a head cannot widen a tool) — this narrows, never widens.
          tools: CLIENT_TOOLS_V1.filter((t) => t.name in this.cfg.handlers).map((t) => ({ name: t.name })),
        }),
      });
      if (!res.ok || !res.body) {
        sub.error(new Error(`run door answered ${res.status}`));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSSEParser();
      const tracker = createClientCallTracker();

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const dialectEvent of parser.push(decoder.decode(value, { stream: true }))) {
          // CX2 side channel: a completed client call executes the handler
          // with the viewer's session and posts the id-matched result; the
          // paused server turn resumes and the stream continues.
          const call = tracker.fold(dialectEvent);
          if (call) {
            void this.executeClientCall(input.runId, call.toolCallId, call.name, call.input, doFetch);
          }
          for (const stock of mapDoorEvent(dialectEvent)) {
            sub.next(stock as unknown as BaseEvent);
          }
        }
      }
      sub.complete();
    } catch (err) {
      if (signal.aborted) sub.complete();
      else sub.error(err);
    }
  }

  private async executeClientCall(
    runId: string,
    toolCallId: string,
    name: string,
    input: Record<string, unknown>,
    doFetch: typeof fetch,
  ): Promise<void> {
    let content: string;
    let isError = false;
    try {
      const handler = this.cfg.handlers[name];
      content = handler ? await handler(input) : `no handler for ${name}`;
      isError = !handler || content.startsWith("refused:");
    } catch (err) {
      content = `handler failed: ${(err as Error).message}`;
      isError = true;
    }
    try {
      await doFetch(this.doorURL(`/agui/run/${encodeURIComponent(runId)}/tool-result`), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.token}` },
        body: JSON.stringify({ toolCallId, content, ...(isError ? { isError: true } : {}) }),
      });
    } catch {
      // The 60s server timeout owns this failure mode (CX2) — never fatal.
    }
  }
}
