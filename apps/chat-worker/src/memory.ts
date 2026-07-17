// memory — the workspace memory plane (saas-agents-native AN6, design §7):
// durable facts, preferences, and catalog context as PROVENANCED entries —
// content · source ref · author · timestamp. No hidden memory: writes happen
// only through the visible `memory_remember` tool (a card in the thread),
// and the console page lists, edits, and deletes with working provenance
// links. Threads read the plane at brief assembly — the entries fold into
// the turn's system context, which is how a remembered fact demonstrably
// shapes later answers.

import type { ToolExecutor, ToolSpec } from "./chat-thread.js";

export interface MemoryEntry {
  id: string;
  content: string;
  /** Provenance: where this was learned (chat:<chatId> for thread writes). */
  source: string;
  /** The authenticated author of the write. */
  author: string;
  createdAt: string;
}

/** The memory plane's RPC surface (worker/DO-side view; tests fake it). */
export interface MemoryRpc {
  remember(entry: { content: string; source: string; author: string; createdAt: string }): Promise<MemoryEntry>;
  listEntries(): Promise<MemoryEntry[]>;
  updateEntry(id: string, content: string): Promise<MemoryEntry | null>;
  deleteEntry(id: string): Promise<boolean>;
}

/** formatMemoryForSystem folds the plane into the turn's system context —
 * the brief assembly read (design §7). Deterministic order; capped so a
 * hoarded memory can't crowd the prompt. */
export function formatMemoryForSystem(entries: MemoryEntry[], cap = 50): string {
  if (entries.length === 0) return "";
  const lines = entries
    .slice(0, cap)
    .map((e) => `- ${e.content} (remembered by ${e.author}, ${e.createdAt.slice(0, 10)})`);
  return `\nWorkspace memory — durable facts and preferences people asked you to keep (use them; cite when load-bearing):\n${lines.join("\n")}`;
}

const REMEMBER_SPEC: ToolSpec = {
  name: "memory_remember",
  description:
    "Store a durable workspace fact or preference in workspace memory (e.g. 'staging deploys need EU region'). Use ONLY when the user explicitly asks you to remember something. The write is visible in the thread and on the console memory page, attributed to the user, with provenance back to this thread. Keep entries short and factual.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "The fact to remember, one or two sentences" },
    },
    required: ["content"],
  },
};

/** withMemoryTool merges the visible remember tool into an executor. */
export function withMemoryTool(
  base: ToolExecutor,
  memory: MemoryRpc,
  ctx: { author: string; source: string; now: () => Date },
): ToolExecutor {
  return {
    specs: () => [...base.specs(), REMEMBER_SPEC],
    async execute(name, input) {
      if (name !== "memory_remember") return base.execute(name, input);
      const content = String(input.content ?? "").trim();
      if (!content) {
        return { summary: "nothing to remember (empty content)", data: { error: "empty" }, isError: true };
      }
      try {
        const entry = await memory.remember({
          content,
          source: ctx.source,
          author: ctx.author,
          createdAt: ctx.now().toISOString(),
        });
        // The visible confirmation — the thread card says exactly what was kept.
        return { summary: `remembered: ${entry.content}`, data: entry };
      } catch (err) {
        return { summary: `memory write failed: ${(err as Error).message}`, data: {}, isError: true };
      }
    },
  };
}
