// model — the production ModelClient (saas-agents-native AN4): the official
// Anthropic SDK over the workspace's OWN key (lock 6 — BYO custody, resolved
// per turn, never stored). Streaming with adaptive thinking; deltas fan to
// heads as they arrive. The ModelClient seam keeps the loop fixture-testable
// — jest injects a scripted client and never touches this file at runtime.

import Anthropic from "@anthropic-ai/sdk";
import type { ModelBlock, ModelClient, ModelRequestMessage, ModelTurnResult, ToolSpec } from "./chat-thread.js";

export const CHAT_MODEL = "claude-opus-4-8";
const MAX_TOKENS = 16000;

// ── Provider selection (saas-dispatch DX6/DX-Q6) ────────────────────────────
// The Workspace Agent's model is BYO like every run's (lock 6): the workspace
// connects a model provider (anthropic / openai / openrouter) and dispatch
// uses its key. Anthropic rides the official SDK; the OpenAI-compatible
// providers (OpenAI, OpenRouter) ride a dependency-free Chat Completions
// client so a single seam covers all three. The key never lands in DO state.

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";

/**
 * The Chat Completions base for an OpenAI-compatible connection. OpenRouter
 * serves TWO dialects from openrouter.ai — the OpenAI-compatible `/api/v1`
 * (what THIS client speaks) and the Anthropic skin `/api` (what sandbox
 * sessions speak) — so any openrouter.ai baseUrl is canonicalized to the
 * OpenAI flavor here rather than trusted verbatim: a connection pinned at
 * the Anthropic skin (or the site root) must not 404 dispatch. Only a
 * non-openrouter.ai host (a real custom gateway) is honored as-is. Keep in
 * lockstep with the session-side canonicalization in agents-worker provision.
 */
function openaiCompatibleBase(provider: string, config: Record<string, unknown>): string {
  const fallback = provider === "openrouter" ? OPENROUTER_DEFAULT_BASE : OPENAI_DEFAULT_BASE;
  const raw = typeof config.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl.trim().replace(/\/$/, "") : "";
  if (!raw) return fallback;
  if (provider === "openrouter") {
    try {
      if (new URL(raw).hostname === "openrouter.ai") return OPENROUTER_DEFAULT_BASE;
    } catch {
      return fallback;
    }
  }
  return raw;
}

/** Build the right ModelClient for a resolved model connection. The model
 * call goes DIRECT to the provider (global fetch), never through api-edge. */
export function modelClientFor(
  provider: string,
  apiKey: string,
  config: Record<string, unknown>,
  fetchFn?: typeof fetch,
): ModelClient | null {
  if (provider === "anthropic") {
    return anthropicModel(apiKey, fetchFn);
  }
  if (provider === "openai" || provider === "openrouter") {
    const model = typeof config.defaultModel === "string" && config.defaultModel.trim() ? config.defaultModel.trim() : "";
    if (!model) return null; // honest: OpenAI-compatible needs an explicit model id
    const baseUrl = openaiCompatibleBase(provider, config);
    return openaiCompatibleModel(apiKey, { baseUrl, model, ...(fetchFn ? { fetchFn } : {}) });
  }
  return null;
}

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

// ── OpenAI-compatible client (OpenAI, OpenRouter) ───────────────────────────

interface OpenAIToolCallAcc {
  id: string;
  name: string;
  args: string;
}

/** Translate the loop's Anthropic-native history into OpenAI chat messages.
 * The loop stores assistant turns as text (string) or ModelBlock[] (tool
 * rounds), and tool results as Anthropic `tool_result` blocks; OpenAI wants
 * `assistant.tool_calls` + `role:"tool"` messages keyed by tool_call_id. */
export function toOpenAIMessages(system: string, messages: ModelRequestMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
    if (m.role === "assistant") {
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: String(b.id),
          type: "function",
          function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // user role carrying tool_result blocks → one OpenAI `tool` message each.
      for (const b of blocks) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: String(b.content ?? "") });
        }
      }
    }
  }
  return out;
}

function mapFinish(reason: string | null | undefined): ModelTurnResult["stopReason"] {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

/**
 * openaiCompatibleModel — a dependency-free streaming Chat Completions client
 * (OpenAI + OpenRouter). SSE deltas fan text to heads as they arrive; tool
 * calls accumulate across chunks; usage rides the final chunk
 * (stream_options.include_usage). Failures throw a redacted status (never a
 * provider body). The returned blocks are the loop's Anthropic-native shape,
 * so the tool-round contract is unchanged.
 */
export function openaiCompatibleModel(
  apiKey: string,
  opts: { baseUrl: string; model: string; fetchFn?: typeof fetch },
): ModelClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const f = opts.fetchFn ?? fetch;
  return {
    async stream(req, onDelta): Promise<ModelTurnResult> {
      const body = {
        model: opts.model,
        messages: toOpenAIMessages(req.system, req.messages),
        ...(req.tools.length
          ? {
              tools: req.tools.map((t: ToolSpec) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
            }
          : {}),
        stream: true,
        stream_options: { include_usage: true },
      };
      const res = await f(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        throw new Error(`${res.status} from model provider`);
      }

      let textOut = "";
      const toolAcc: OpenAIToolCallAcc[] = [];
      let finish: string | null = null;
      let usage: { inputTokens: number; outputTokens: number } | undefined;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            let chunk: {
              choices?: Array<{
                delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
                finish_reason?: string | null;
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            const choice = chunk.choices?.[0];
            if (choice?.delta?.content) {
              textOut += choice.delta.content;
              onDelta(choice.delta.content);
            }
            for (const tc of choice?.delta?.tool_calls ?? []) {
              const slot = (toolAcc[tc.index] ??= { id: "", name: "", args: "" });
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name = tc.function.name;
              if (tc.function?.arguments) slot.args += tc.function.arguments;
            }
            if (choice?.finish_reason) finish = choice.finish_reason;
            if (chunk.usage) {
              usage = {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
              };
            }
          }
        }
      }

      const blocks: ModelBlock[] = [];
      if (textOut) blocks.push({ type: "text", text: textOut });
      for (const tc of toolAcc) {
        if (!tc.name) continue;
        let input: Record<string, unknown> = {};
        try {
          input = tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id || `call_${blocks.length}`, name: tc.name, input });
      }
      const stopReason = toolAcc.some((t) => t.name) ? "tool_use" : mapFinish(finish);
      return { blocks, stopReason, ...(usage ? { usage } : {}) };
    },
  };
}

/** The Workspace Agent's voice — the system prompt. Conversation and
 * orchestration only; the amended AG lock is IN the prompt so the model's
 * self-model matches the structure around it.
 *
 * DD5 (saas-dispatch-delight): the prompt carries the PUBLIC workspace
 * identity (`org_<hex>` id — the form every public surface accepts — and the
 * slug when the caller knows it), never the internal DO-key UUID, and tells
 * the model how to talk about identifiers: names for people, ids as
 * follow-up metadata. */
export function workspaceSystemPrompt(workspace: { orgPublicId: string; slug?: string }): string {
  const name = workspace.slug ? `"${workspace.slug}" (${workspace.orgPublicId})` : workspace.orgPublicId;
  return [
    "You are the Workspace Agent for this sourceplane workspace — a durable, conversational orchestrator.",
    "You can READ the workspace through your tools: catalog, runs, work plane, audit, usage, config.",
    "You cannot execute anything: no shell, no files, no repos, no deploys. Execution happens in governed",
    "orun sessions which humans (and, later, your session verbs) dispatch through gated doors.",
    "Answer questions about live workspace state by using your read tools rather than guessing;",
    "cite ids (runs, tasks, sessions) so people can follow your links. If asked to change something",
    "or run something, explain that execution lands in a governed session and point at the console",
    "affordance — never fabricate a capability you do not have.",
    `Workspace: ${name}. Refer to the workspace by its name in conversation — never surface a raw`,
    "UUID; give an entity's public id (run, task, session) beside its name when someone would need",
    "it to follow up, not instead of a name. Be direct, concrete, and brief; surface specifics and",
    "numbers over adjectives.",
  ].join(" ");
}
