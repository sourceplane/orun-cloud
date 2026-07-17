// model — the production ModelClient (saas-agents-native AN4): the official
// Anthropic SDK over the workspace's OWN key (lock 6 — BYO custody, resolved
// per turn, never stored). Streaming with adaptive thinking; deltas fan to
// heads as they arrive. The ModelClient seam keeps the loop fixture-testable
// — jest injects a scripted client and never touches this file at runtime.

import Anthropic from "@anthropic-ai/sdk";
import type { ModelBlock, ModelClient, ModelTurnResult, ToolSpec } from "./chat-thread.js";

export const CHAT_MODEL = "claude-opus-4-8";
const MAX_TOKENS = 16000;

export function anthropicModel(apiKey: string, fetchFn?: typeof fetch): ModelClient {
  const client = new Anthropic({ apiKey, ...(fetchFn ? { fetch: fetchFn } : {}) });
  return {
    async stream(req, onDelta): Promise<ModelTurnResult> {
      const stream = client.messages.stream({
        model: CHAT_MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        system: req.system,
        tools: req.tools.map((t: ToolSpec) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        messages: req.messages as Anthropic.MessageParam[],
      });
      stream.on("text", (delta) => onDelta(delta));
      const message = await stream.finalMessage();

      const blocks: ModelBlock[] = [];
      for (const b of message.content) {
        if (b.type === "text") blocks.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") {
          blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> });
        }
      }
      const usage = {
        inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      };
      const stop = message.stop_reason;
      const stopReason: ModelTurnResult["stopReason"] =
        stop === "tool_use" ? "tool_use" : stop === "max_tokens" ? "max_tokens" : stop === "refusal" ? "refusal" : "end_turn";
      return { blocks, stopReason, usage };
    },
  };
}

/** The Workspace Agent's voice — the system prompt. Conversation and
 * orchestration only; the amended AG lock is IN the prompt so the model's
 * self-model matches the structure around it. */
export function workspaceSystemPrompt(orgId: string): string {
  return [
    "You are the Workspace Agent for this sourceplane workspace — a durable, conversational orchestrator.",
    "You can READ the workspace through your tools: catalog, runs, work plane, audit, usage, config.",
    "You cannot execute anything: no shell, no files, no repos, no deploys. Execution happens in governed",
    "orun sessions which humans (and, later, your session verbs) dispatch through gated doors.",
    "Answer questions about live workspace state by using your read tools rather than guessing;",
    "cite ids (runs, tasks, sessions) so people can follow your links. If asked to change something",
    "or run something, explain that execution lands in a governed session and point at the console",
    "affordance — never fabricate a capability you do not have.",
    `Workspace: ${orgId}. Be direct, concrete, and brief; surface ids and numbers over adjectives.`,
  ].join(" ");
}
