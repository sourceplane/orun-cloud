// session-verbs — the Workspace Agent's hands (saas-agents-native AN5).
// Four verbs, all re-entering PUBLIC surfaces with the chat owner's
// credential (lock 4): spawn walks the AG9 dispatch door (entitlement,
// ladder, spawn gates, budget door all apply server-side — the chat agent is
// just another gated caller, and a refusal renders in-thread); steer and
// interrupt ride the AL input route with an explicit `via: workspace-agent`
// disclosure in the frame payload (the sealed log shows both the
// authenticated owner AND the agent authorship); watch folds the child's
// live state + recent events + pending approvals into a thread card.
//
// LOCK 5 IS STRUCTURAL: there is no verdict verb. The input door here sends
// steer/interrupt frames only — approval verdicts cannot be expressed
// through this module at all, and the CI suite pins that. Approvals SURFACE
// in the watch card; answering them is a human act on the session page.

import type { ToolExecutor, ToolSpec } from "./chat-thread.js";

export interface VerbHttp {
  fetch(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response>;
}

export interface SessionVerbDeps {
  baseUrl: string;
  ownerToken: string;
  http: VerbHttp;
  orgPublicId: string;
  /** Correlation-ref source for input frames (injectable for tests). */
  newRef?: () => string;
}

/** The verbs the model sees. Wire names are snake_case like the platform
 * tools; descriptions carry the trigger conditions AND the governance story
 * so the model narrates honestly. */
export function sessionVerbSpecs(): ToolSpec[] {
  return [
    {
      name: "session_spawn",
      description:
        "Dispatch a governed orun session for a work-plane task (the execution door). Use when the user asks to ship, fix, implement, or run something. The dispatch passes the workspace's entitlement, autonomy ladder, spawn gates, and budget door — if it is refused, report the refusal reason verbatim so the user can act on it. At autonomy level 'assist', propose the spawn and get the user's explicit confirmation in this thread BEFORE calling this tool.",
      inputSchema: {
        type: "object",
        properties: {
          taskKey: { type: "string", description: "The work-plane task key to dispatch (e.g. ORN-142)" },
          specKey: { type: "string", description: "Optional spec key scoping the dispatch" },
        },
        required: ["taskKey"],
      },
    },
    {
      name: "session_steer",
      description:
        "Send a steering message into a live session's input queue. The message lands in the sealed session log attributed to the chat owner with an explicit workspace-agent disclosure. Use only for sessions the user is discussing.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The session public id (as_…)" },
          text: { type: "string", description: "The steering message" },
        },
        required: ["sessionId", "text"],
      },
    },
    {
      name: "session_interrupt",
      description:
        "Interrupt a live session's current turn (graceful — the runtime finishes its current tool call). Use when the user asks to stop or redirect a running session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The session public id (as_…)" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "session_watch",
      description:
        "Fold a session's live state into this thread: current state, recent events, and any PENDING APPROVALS. Approvals can only be answered by a human on the session page — surface them clearly with the session link; never claim you can approve or deny.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The session public id (as_…)" },
        },
        required: ["sessionId"],
      },
    },
  ];
}

const VERB_NAMES = new Set(sessionVerbSpecs().map((s) => s.name));

export function isSessionVerb(name: string): boolean {
  return VERB_NAMES.has(name);
}

interface EventRow {
  seq: number;
  kind: string;
  payload?: Record<string, unknown>;
}

/** executeSessionVerb — one verb through the public doors. Errors are honest
 * results (is_error), never throws. */
export async function executeSessionVerb(
  name: string,
  input: Record<string, unknown>,
  deps: SessionVerbDeps,
): Promise<{ summary: string; data: unknown; isError?: boolean }> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${deps.ownerToken}`,
  };
  const agentsBase = `${deps.baseUrl}/v1/organizations/${deps.orgPublicId}/agents`;
  const newRef = deps.newRef ?? (() => `wa-${crypto.randomUUID().slice(0, 8)}`);

  const readError = async (res: Response): Promise<string> => {
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      return body.error?.message || body.error?.code || `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}`;
    }
  };

  try {
    switch (name) {
      case "session_spawn": {
        const res = await deps.http.fetch(`${agentsBase}/dispatch`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            taskKey: input.taskKey,
            ...(typeof input.specKey === "string" && input.specKey ? { specKey: input.specKey } : {}),
          }),
        });
        if (!res.ok) {
          // The refusal IS the product here: budget door, ladder, spawn gate,
          // entitlement — whatever said no, the thread shows why.
          const reason = await readError(res);
          return { summary: `spawn refused: ${reason}`, data: { refused: true, reason }, isError: true };
        }
        const body = (await res.json()) as { data?: { id?: string; state?: string } };
        return {
          summary: `session ${body.data?.id ?? "?"} dispatched (${body.data?.state ?? "requested"})`,
          data: body.data ?? {},
        };
      }
      case "session_steer":
      case "session_interrupt": {
        const sessionId = String(input.sessionId ?? "");
        const frame =
          name === "session_steer"
            ? {
                v: 1,
                t: "steer",
                ref: newRef(),
                text: String(input.text ?? ""),
                // Disclosure (design §6.1): the sealed log shows the owner's
                // authenticated principal AND the agent authorship.
                payload: { via: "workspace-agent" },
              }
            : { v: 1, t: "interrupt", ref: newRef(), payload: { via: "workspace-agent" } };
        const res = await deps.http.fetch(`${agentsBase}/sessions/${encodeURIComponent(sessionId)}/input`, {
          method: "POST",
          headers,
          body: JSON.stringify(frame),
        });
        if (!res.ok) {
          const reason = await readError(res);
          return { summary: `${name} failed: ${reason}`, data: { reason }, isError: true };
        }
        const ack = (await res.json()) as { ok?: boolean; reason?: string };
        if (ack.ok === false) {
          return { summary: `${name} not delivered: ${ack.reason ?? "unknown"}`, data: ack, isError: true };
        }
        return { summary: `${name === "session_steer" ? "steer" : "interrupt"} delivered to ${sessionId}`, data: ack };
      }
      case "session_watch": {
        const sessionId = String(input.sessionId ?? "");
        const [sres, eres] = await Promise.all([
          deps.http.fetch(`${agentsBase}/sessions/${encodeURIComponent(sessionId)}`, { headers }),
          deps.http.fetch(`${agentsBase}/sessions/${encodeURIComponent(sessionId)}/events`, { headers }),
        ]);
        if (!sres.ok) {
          const reason = await readError(sres);
          return { summary: `watch failed: ${reason}`, data: { reason }, isError: true };
        }
        const session = ((await sres.json()) as { data?: Record<string, unknown> }).data ?? {};
        const events: EventRow[] = eres.ok ? (((await eres.json()) as { data?: EventRow[] }).data ?? []) : [];

        // Pending approvals: requested without a matching resolution — the
        // sticky card, folded for the thread. Never answerable from here.
        const resolved = new Set(
          events.filter((e) => e.kind === "approval_resolved").map((e) => String(e.payload?.requestId ?? "")),
        );
        const pendingApprovals = events
          .filter((e) => e.kind === "approval_requested" && !resolved.has(String(e.payload?.requestId ?? "")))
          .map((e) => ({ requestId: String(e.payload?.requestId ?? ""), tool: String(e.payload?.tool ?? "") }));
        const recent = events.slice(-10).map((e) => ({ seq: e.seq, kind: e.kind }));

        return {
          summary: `session ${sessionId}: ${String(session.state ?? "unknown")}${pendingApprovals.length ? ` — ${pendingApprovals.length} approval(s) WAITING ON A HUMAN` : ""}`,
          data: { session, recent, pendingApprovals },
        };
      }
      default:
        return { summary: `unknown verb ${name}`, data: { error: "unknown_verb" }, isError: true };
    }
  } catch (err) {
    return { summary: `${name} failed: ${(err as Error).message}`, data: { error: String((err as Error).message) }, isError: true };
  }
}

/** withSessionVerbs merges the verbs into a base (read-only) executor. */
export function withSessionVerbs(base: ToolExecutor, deps: SessionVerbDeps): ToolExecutor {
  return {
    specs: () => [...base.specs(), ...sessionVerbSpecs()],
    async execute(name, input) {
      if (isSessionVerb(name)) return executeSessionVerb(name, input, deps);
      return base.execute(name, input);
    },
  };
}
