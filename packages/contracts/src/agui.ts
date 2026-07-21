// AG-UI dialect (saas-copilot-surface CX0, design §1). The event vocabulary
// the platform EMITS and the RunAgentInput subset it ACCEPTS — pinned here so
// upstream protocol drift is a versioned adapter change, never a silent
// break. The bridge translates the existing chat-v1 / attach-v1 wires into
// this vocabulary; nothing here is a second store of truth (same seq, same
// cursor as the native frames).
//
// Deviations from stock AG-UI are deliberate and documented:
//   * `MESSAGES_SNAPSHOT` carries `append: true` + only the NEW durable rows
//     (the DO's history is the truth; full-snapshot replay rides the existing
//     history GET, not the event stream).
//   * every seq-bearing event carries `seq` — the native cursor watermark —
//     so a head can dedupe across the WS fold and this dialect.

/** The dialect version this codebase emits/accepts. Bump = adapter change. */
export const AGUI_DIALECT_VERSION = 1 as const;

export const AGUI_EVENT_TYPES = [
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_RESULT",
  "STATE_SNAPSHOT",
  "STATE_DELTA",
  "MESSAGES_SNAPSHOT",
  "CUSTOM",
] as const;
export type AguiEventType = (typeof AGUI_EVENT_TYPES)[number];

/** One durable thread message as the dialect carries it (the chat-v1 `msg`
 * row, re-serialized — heads that already fold chat-v1 see the same shape). */
export interface AguiMessage {
  seq: number;
  role: "user" | "assistant" | "tool";
  text: string;
  at?: string;
  tool?: { name: string; phase: "call" | "result"; summary: string; isError?: boolean };
  principal?: string;
  error?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

/** A generative-UI card payload riding a TOOL_CALL_RESULT or CUSTOM event.
 * `data` is an EXISTING contracts shape (ReadyItem / SessionCard /
 * AttentionItem / BudgetEnvelope / ProviderConnection…) — the D5 two-plane
 * guard is inherited, never re-litigated (design §4). */
export interface AguiCard {
  plane: "work" | "session" | "governance";
  type: string;
  data: unknown;
}

/** JSON-Patch-lite op for STATE_DELTA (replace-only in dialect v1). */
export interface AguiStateOp {
  op: "replace";
  path: string;
  value: unknown;
}

/** The event union — a flat tagged shape keyed by `type` (one wire struct,
 * the attach-frame idiom). Unknown fields are preserved on relay, ignored on
 * consume; unknown types MUST be ignored by heads (forward compatibility). */
export interface AguiEvent {
  v: typeof AGUI_DIALECT_VERSION;
  type: AguiEventType;
  /** Native cursor watermark, present on events derived from seq-bearing
   * frames — the dedupe key across this dialect and the WS fold. */
  seq?: number;

  // RUN_*
  threadId?: string;
  runId?: string;
  /** RUN_ERROR: machine code (e.g. `turn_in_progress`) + human message. */
  code?: string;
  message?: string;

  // TEXT_MESSAGE_*
  messageId?: string;
  role?: string;
  delta?: string;

  // TOOL_CALL_*
  toolCallId?: string;
  toolCallName?: string;
  /** TOOL_CALL_RESULT: the rendered result summary. */
  content?: string;
  isError?: boolean;
  /** TOOL_CALL_RESULT: optional typed card (design §4). */
  card?: AguiCard;

  // STATE_*
  snapshot?: Record<string, unknown>;
  ops?: AguiStateOp[];

  // MESSAGES_SNAPSHOT (dialect: append-only increments)
  messages?: AguiMessage[];
  append?: boolean;

  // CUSTOM
  name?: string;
  value?: unknown;
}

// ── RunAgentInput (the subset the run door accepts, design §2.1) ────────────

/** A client tool the head advertises for ONE turn. Must name a registry
 * entry (CLIENT_TOOLS_V1) — free-form advertisement is rejected at the door:
 * the model's tool surface is code, not client input. */
export interface AguiClientTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface AguiRunInput {
  threadId?: string;
  runId?: string;
  /** Advisory tail only — the DO's history is the truth; a mismatch is
   * resolved by ignoring the client copy. The LAST user message's text is
   * the turn's input. */
  messages?: Array<{ role: string; content: string }>;
  tools?: AguiClientTool[];
  forwardedProps?: Record<string, unknown>;
}

// ── The client-tool registry (CX2, design §3.3) ─────────────────────────────
// Six verbs, all reversible, all visible (each renders an action chip).
// Review bar (§3.2): prefill never submit, open never approve — a verb that
// could not be safely executed by a hostile model against a distracted
// viewer does not enter this list.

export interface ClientToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const CLIENT_TOOLS_V1: readonly ClientToolSpec[] = [
  {
    name: "ui_navigate",
    description: "Navigate the viewer's console to an org-scoped route.",
    parameters: { type: "object", properties: { route: { type: "string" } }, required: ["route"] },
  },
  {
    name: "ui_open_work_item",
    description: "Open a work item by key in the console.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "ui_open_session",
    description: "Open an agent session page by id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "ui_prefill_spawn",
    description: "Pre-fill (never submit) the session spawn form.",
    parameters: {
      type: "object",
      properties: { taskKey: { type: "string" }, profileId: { type: "string" } },
      required: [],
    },
  },
  {
    name: "ui_copy",
    description: "Copy text to the viewer's clipboard.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "ui_highlight_situation",
    description: "Highlight a Situation rail section (ready | inFlight | waitingOnMe | budget).",
    parameters: { type: "object", properties: { section: { type: "string" } }, required: ["section"] },
  },
] as const;

export const CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set(CLIENT_TOOLS_V1.map((t) => t.name));

/** True when every advertised tool names a registry entry. */
export function validClientTools(tools: AguiClientTool[] | undefined): boolean {
  if (!tools) return true;
  return tools.every((t) => CLIENT_TOOL_NAMES.has(t.name));
}
