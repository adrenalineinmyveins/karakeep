/**
 * PI SDK 适配层
 *
 * 将 pi-agent-core / pi-ai 封装在单一文件内，其余代码面向
 * AgentInterface / ToolDefinition 编程。若未来替换 SDK，只需
 * 提供一个新的 implements，业务代码（orchestrator/tools）不动。
 *
 * 模型解析规则（resolveDefaultPattern）：
 * - OPENAI_API_KEY + OPENAI_BASE_URL → custom-openai provider（OpenAI 兼容端点，
 *   如智谱 / OneAPI / vLLM），走 chat/completions 协议，模型名取 CHAT_MODEL
 * - 仅 OPENAI_API_KEY → 官方 openai provider（内置模型表），走 responses 协议
 * - OLLAMA_BASE_URL → 暂不支持，降级 openai 官方 + textModel
 * - 都没配 → 降级 openai 官方 + gpt-4o-mini
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent as PIAgentEvent,
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import type { TSchema } from "typebox";
import { z } from "zod";

import serverConfig from "@saiye/shared/config";
import logger from "@saiye/shared/logger";

// ── 对外接口抽象 ──────────────────────────────────────

/** 业务侧的工具定义（在 SDK 边界由 zodToToolSchema 构造） */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（由 Zod 转换） */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/** 业务侧事件：AgentEvent 是 PI 原生事件的精简投影 */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "token_delta"; delta: string }
  | {
      type: "tool_call";
      toolName: string;
      status: "start" | "end";
      args?: unknown;
      result?: unknown;
    }
  | { type: "message_complete"; content: string }
  | { type: "error"; message: string };

export interface AgentInterface {
  prompt(text: string): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): () => void;
  abort(): void;
}

export interface CreateAgentParams {
  systemPrompt: string;
  tools: ToolDefinition[];
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

// ── Zod → JSON Schema ────────────────────────────────

/**
 * 将 Zod schema 转换为 PI SDK 要求的 JSON Schema 工具定义。
 * Zod 4 原生支持 toJSONSchema。
 */
export function zodToToolSchema(
  name: string,
  description: string,
  zodSchema: z.ZodSchema,
  executor: (args: Record<string, unknown>) => Promise<string>,
): ToolDefinition {
  return {
    name,
    description,
    parameters: z.toJSONSchema(zodSchema),
    execute: executor,
  };
}

// ── 模型解析 ─────────────────────────────────────────

export function resolveDefaultPattern(): { provider: string; modelId: string } {
  if (
    serverConfig.inference.openAIApiKey &&
    serverConfig.inference.openAIBaseUrl
  ) {
    return {
      provider: "custom-openai",
      modelId: serverConfig.inference.chatModel,
    };
  }
  if (serverConfig.inference.openAIApiKey) {
    return {
      provider: "openai",
      modelId: serverConfig.inference.chatModel,
    };
  }
  if (serverConfig.inference.ollamaBaseUrl) {
    logger.warn(
      "Ollama support for Agent is not yet implemented. Falling back to OpenAI.",
    );
    return {
      provider: "openai",
      modelId: serverConfig.inference.textModel,
    };
  }
  logger.warn(
    "No AI provider configured. Set OPENAI_API_KEY or OLLAMA_BASE_URL.",
  );
  return { provider: "openai", modelId: "gpt-4o-mini" };
}

// ── Models 单例（进程级缓存） ────────────────────────

let modelsInstance: MutableModels | null = null;

function ensureModels(): MutableModels {
  if (!modelsInstance) {
    const models = createModels();
    if (
      serverConfig.inference.openAIApiKey &&
      serverConfig.inference.openAIBaseUrl
    ) {
      // OpenAI 兼容端点：单模型注册，走 chat/completions 协议
      models.setProvider(
        createProvider({
          id: "custom-openai",
          name: "Custom OpenAI Compatible",
          baseUrl: serverConfig.inference.openAIBaseUrl,
          auth: {
            apiKey: envApiKeyAuth("Custom OpenAI API key", ["OPENAI_API_KEY"]),
          },
          models: [
            {
              id: serverConfig.inference.chatModel,
              name: serverConfig.inference.chatModel,
              api: "openai-completions",
              provider: "custom-openai",
              baseUrl: serverConfig.inference.openAIBaseUrl,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
          api: openAICompletionsApi(),
        }),
      );
    } else if (serverConfig.inference.openAIApiKey) {
      // 官方 OpenAI：内置模型表，走 responses 协议
      models.setProvider(
        createProvider({
          id: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          auth: {
            apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]),
          },
          models: Object.values(OPENAI_MODELS),
          api: openAIResponsesApi(),
        }),
      );
    }
    modelsInstance = models;
  }
  return modelsInstance;
}

// ── Agent 工厂 ───────────────────────────────────────

/** 单轮 LLM 调用（一次 streamSimple）的硬超时 */
const LLM_STREAM_TIMEOUT_MS = 60_000;

export function createAgent(params: CreateAgentParams): AgentInterface {
  const models = ensureModels();
  const { provider, modelId } = resolveDefaultPattern();
  const model = models.getModel(provider, modelId);
  if (!model) {
    throw new Error(
      `Model not found: ${provider}/${modelId}. Check CHAT_MODEL config.`,
    );
  }

  // 工具映射：ToolDefinition → AgentTool
  const tools = params.tools.map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: t.parameters as unknown as TSchema,
    execute: async (_toolCallId: string, params: unknown) => ({
      content: [
        {
          type: "text" as const,
          text: await t.execute(params as Record<string, unknown>),
        },
      ],
      details: null,
    }),
  }));

  // 历史映射：{role, content} → PI Message（assistant 补空 usage 以满足类型/统计）
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  const messages = (params.history ?? []).map((m) => {
    const msg: Record<string, unknown> = {
      role: m.role,
      content: [{ type: "text", text: m.content }],
      timestamp: Date.now(),
    };
    if (m.role === "assistant") {
      msg.usage = emptyUsage;
    }
    return msg;
  }) as unknown as AgentMessage[];

  const agent = new Agent({
    initialState: {
      systemPrompt: params.systemPrompt,
      model,
      tools,
      messages,
    },
    streamFn: (model, context, options) =>
      models.streamSimple(model, context, {
        ...options,
        // 单轮 LLM 调用硬超时：上游挂死时中止请求，避免无限等待
        signal: AbortSignal.timeout(LLM_STREAM_TIMEOUT_MS),
      }),
  });

  return {
    prompt: (text: string) => agent.prompt(text),
    subscribe: (handler: (event: AgentEvent) => void) =>
      agent.subscribe((evt) => {
        const mapped = mapPIEvent(evt);
        if (mapped) {
          handler(mapped);
        }
      }),
    abort: () => agent.abort(),
  };
}

// ── PI 事件 → 业务事件 ───────────────────────────────

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "object" &&
        c !== null &&
        (c as { type?: string }).type === "text"
          ? ((c as { text?: string }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

function mapPIEvent(evt: PIAgentEvent): AgentEvent | null {
  switch (evt.type) {
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return { type: "agent_end" };
    case "message_update": {
      const { assistantMessageEvent } = evt;
      if (
        assistantMessageEvent.type === "text_delta" &&
        "delta" in assistantMessageEvent
      ) {
        return {
          type: "token_delta",
          delta: assistantMessageEvent.delta,
        };
      }
      return null;
    }
    case "tool_execution_start":
      return {
        type: "tool_call",
        toolName: evt.toolName,
        status: "start",
        args: evt.args,
      };
    case "tool_execution_end":
      return {
        type: "tool_call",
        toolName: evt.toolName,
        status: "end",
        result: evt.result,
      };
    case "turn_end": {
      const message = evt.message;
      if (message && typeof message === "object") {
        const m = message as {
          stopReason?: string;
          errorMessage?: string;
        };
        if (m.stopReason === "error") {
          const errorMessage =
            typeof m.errorMessage === "string" ? m.errorMessage : "";
          return {
            type: "error",
            message: errorMessage
              ? `模型调用失败: ${errorMessage}`
              : "模型调用失败，请检查 API 配置和账户余额",
          };
        }
      }
      const content = messageText(message);
      if (content) {
        return { type: "message_complete", content };
      }
      return null;
    }
    default:
      return null;
  }
}
