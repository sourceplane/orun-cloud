// chat-thread — the Workspace Agent's conversation core (saas-agents-native
// AN4). Pure and storage-injectable like RelayCore: durable message history,
// WS head fan-out (replay → live, the attach idiom on a new noun), and the
// model turn loop with tool rounds. The DO shell (workspace-agent.ts) binds
// it to real storage, connections, custody, and the model; jest drives it
// with fakes and recorded-model fixtures.
//
// The wire is chat-v1 — a small frame vocabulary modeled on attach v1:
//   head → DO : none over WS (turns POST through the worker, carrying the
//               owner's credential — the WS is the read plane)
//   DO → head : hello · msg (replay + live) · live · delta · turn ·
//               tool · error · bye
//
// The model loop: user text → model stream (deltas fan out live) → tool_use
// rounds (read-only platform tools, executed with the OWNER's credential) →
// final assistant message. A custody or model failure lands as an honest,
// retryable ERROR TURN in the thread — never a hang (AN4 done-when).

export interface ChatStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
}

export interface ConnectionLike {
  readonly id: string;
  send(msg: string): void;
  close(code?: number, reason?: string): void;
  setState(state: unknown): void;
  readonly state: unknown;
}

/** One durable thread message. Content blocks are the model-facing truth
 * (assistant turns keep their tool_use blocks so the loop can be replayed);
 * `text` is the rendered fold for heads. */
export interface ChatMessage {
  seq: number;
  role: "user" | "assistant" | "tool";
  text: string;
  at: string;
  /** Model-facing content blocks (assistant/tool rounds). */
  blocks?: unknown[];
  /** Tool round metadata for head rendering. */
  tool?: { name: string; phase: "call" | "result"; summary: string; isError?: boolean };
  /** The authenticated author of a user turn (edge-stamped). */
  principal?: string;
  /** True for the honest error turn (custody/model failure — retryable). */
  error?: boolean;
}

// ── The model seam (recorded-fixture testable) ──────────────────────────────

export type ModelBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface ModelTurnResult {
  blocks: ModelBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
}

export interface ModelRequestMessage {
  role: "user" | "assistant";
  content: unknown; // string | content blocks (tool_result rounds)
}

/** The model client: one streamed request. Deltas fire as text arrives. */
export interface ModelClient {
  stream(
    req: { system: string; messages: ModelRequestMessage[]; tools: ToolSpec[] },
    onDelta: (text: string) => void,
  ): Promise<ModelTurnResult>;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolExecutor {
  specs(): ToolSpec[];
  /** Execute one read-only platform tool with the OWNER's credential.
   * Returns a summary + data; throws never (errors come back as results). */
  execute(name: string, input: Record<string, unknown>): Promise<{ summary: string; data: unknown; isError?: boolean }>;
}

const MSG_PREFIX = "m:";
const META_KEY = "chat:meta";
const MAX_TOOL_ROUNDS = 8;

function pad(seq: number): string {
  return String(seq).padStart(12, "0");
}

export interface ChatMeta {
  chatId: string;
  orgId: string;
  title: string;
  createdAt: string;
}

/** ChatThread folds the durable conversation and serves its heads. */
export class ChatThread {
  private meta: ChatMeta | null = null;
  private messages: ChatMessage[] = [];
  private heads = new Map<string, ConnectionLike>();
  private turnActive = false;

  constructor(private storage: ChatStorage) {}

  async load(): Promise<void> {
    this.meta = (await this.storage.get<ChatMeta>(META_KEY)) ?? null;
    const stored = await this.storage.list<ChatMessage>({ prefix: MSG_PREFIX });
    this.messages = [...stored.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, m]) => m);
  }

  /** init binds the thread to its workspace — IMMUTABLY (design §5.1): a
   * thread never migrates workspaces; a second init with a different org is
   * refused loudly. */
  async init(meta: ChatMeta): Promise<void> {
    if (this.meta && this.meta.orgId !== meta.orgId) {
      throw new Error("chat thread is bound to another workspace");
    }
    if (!this.meta) {
      this.meta = meta;
      await this.storage.put(META_KEY, meta);
    }
  }

  info(): ChatMeta | null {
    return this.meta;
  }

  /** assertOrg guards every door with the immutable binding. */
  assertOrg(orgId: string): void {
    if (!this.meta || this.meta.orgId !== orgId) {
      throw new Error("chat thread is bound to another workspace");
    }
  }

  history(): ChatMessage[] {
    return [...this.messages];
  }

  // ── Heads (the read plane) ────────────────────────────────────────────────

  connect(conn: ConnectionLike, from: number): void {
    conn.setState({ role: "chat-head" });
    conn.send(this.frame({ t: "hello", chatId: this.meta?.chatId ?? "", title: this.meta?.title ?? "", latestSeq: this.latestSeq() }));
    for (const m of this.messages) {
      if (m.seq > from) conn.send(this.frame({ t: "msg", ...m }));
    }
    conn.send(this.frame({ t: "live" }));
    this.heads.set(conn.id, conn);
  }

  rejoin(conn: ConnectionLike): void {
    if (conn.state === null || conn.state === undefined) return;
    if (!this.heads.has(conn.id)) this.heads.set(conn.id, conn);
  }

  disconnect(id: string): void {
    this.heads.delete(id);
  }

  headCount(): number {
    return this.heads.size;
  }

  private frame(obj: Record<string, unknown>): string {
    return JSON.stringify({ v: 1, ...obj });
  }

  private fanOut(obj: Record<string, unknown>): void {
    const line = this.frame(obj);
    for (const h of this.heads.values()) {
      try {
        h.send(line);
      } catch {
        // A dead socket leaves via onClose.
      }
    }
  }

  private latestSeq(): number {
    return this.messages.length === 0 ? -1 : this.messages[this.messages.length - 1]!.seq;
  }

  private async append(msg: Omit<ChatMessage, "seq">): Promise<ChatMessage> {
    const full: ChatMessage = { seq: this.latestSeq() + 1, ...msg };
    this.messages.push(full);
    await this.storage.put(MSG_PREFIX + pad(full.seq), full);
    this.fanOut({ t: "msg", ...full });
    return full;
  }

  // ── The turn loop (the voice) ─────────────────────────────────────────────

  /**
   * runTurn: one user turn through the model with tool rounds. `resolveModel`
   * runs at turn time (lock 6: the key resolves through custody per turn and
   * is never stored); a null model is the honest error turn. Concurrent turns
   * are refused (one voice per thread at a time).
   */
  async runTurn(
    text: string,
    principal: string,
    deps: {
      resolveModel: () => Promise<ModelClient | null>;
      tools: ToolExecutor;
      system: string;
      now?: () => Date;
    },
  ): Promise<{ ok: boolean; reason?: string }> {
    if (this.turnActive) {
      return { ok: false, reason: "turn_in_progress" };
    }
    this.turnActive = true;
    const now = deps.now ?? (() => new Date());
    try {
      await this.append({ role: "user", text, at: now().toISOString(), principal });
      this.fanOut({ t: "turn", phase: "start" });

      const model = await deps.resolveModel();
      if (!model) {
        await this.append({
          role: "assistant",
          text: "I can't reach the workspace's Anthropic connection right now — the model key didn't resolve. Check the provider connection under Agents → Providers, then send your message again.",
          at: now().toISOString(),
          error: true,
        });
        this.fanOut({ t: "turn", phase: "done" });
        return { ok: false, reason: "custody_failed" };
      }

      const toolSpecs = deps.tools.specs();
      const history = this.modelHistory();

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        let result: ModelTurnResult;
        try {
          // Snapshot per call: the loop mutates `history` between rounds and
          // the model client must never see (or alias) later mutations.
          result = await model.stream({ system: deps.system, messages: [...history], tools: toolSpecs }, (delta) => {
            this.fanOut({ t: "delta", text: delta });
          });
        } catch (err) {
          await this.append({
            role: "assistant",
            text: `The model call failed (${(err as Error).message}). Nothing was lost — send your message again to retry.`,
            at: now().toISOString(),
            error: true,
          });
          this.fanOut({ t: "turn", phase: "done" });
          return { ok: false, reason: "model_failed" };
        }

        const textOut = result.blocks
          .filter((b): b is Extract<ModelBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        const toolUses = result.blocks.filter(
          (b): b is Extract<ModelBlock, { type: "tool_use" }> => b.type === "tool_use",
        );

        if (result.stopReason !== "tool_use" || toolUses.length === 0 || round === MAX_TOOL_ROUNDS) {
          await this.append({
            role: "assistant",
            text: textOut || (result.stopReason === "refusal" ? "I can't help with that request." : ""),
            at: now().toISOString(),
            blocks: result.blocks,
          });
          this.fanOut({ t: "turn", phase: "done" });
          return { ok: true };
        }

        // Tool round: visible cards for every call, then results back to the
        // model in one user message (the parallel-tool-use contract).
        history.push({ role: "assistant", content: result.blocks });
        const toolResults: unknown[] = [];
        for (const call of toolUses) {
          await this.append({
            role: "tool",
            text: textOut,
            at: now().toISOString(),
            tool: { name: call.name, phase: "call", summary: JSON.stringify(call.input) },
          });
          const out = await deps.tools.execute(call.name, call.input);
          await this.append({
            role: "tool",
            text: "",
            at: now().toISOString(),
            tool: { name: call.name, phase: "result", summary: out.summary, ...(out.isError ? { isError: true } : {}) },
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: JSON.stringify(out.data),
            ...(out.isError ? { is_error: true } : {}),
          });
        }
        history.push({ role: "user", content: toolResults });
      }
      return { ok: true };
    } finally {
      this.turnActive = false;
    }
  }

  /** modelHistory rebuilds the model-facing conversation from the durable
   * thread: user text turns and assistant block turns; tool cards are
   * head-rendering artifacts, not model context (the blocks already carry
   * the tool_use; results were consumed in-loop and the final assistant
   * message carries their substance). */
  private modelHistory(): ModelRequestMessage[] {
    const out: ModelRequestMessage[] = [];
    for (const m of this.messages) {
      if (m.role === "user") {
        out.push({ role: "user", content: m.text });
      } else if (m.role === "assistant" && !m.error) {
        // Persisted assistant turns re-enter as plain text (their tool
        // rounds resolved in-loop; replaying tool_use without results would
        // break the alternation contract).
        if (m.text) out.push({ role: "assistant", content: m.text });
      }
    }
    return out;
  }
}
