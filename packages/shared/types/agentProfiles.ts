import { z } from "zod";

/** Agent 档案类型：OpenAI 兼容端点 / TraeCode CLI */
export const AGENT_PROFILE_TYPES = ["openai-compatible", "trae-cli"] as const;
export type AgentProfileType = (typeof AGENT_PROFILE_TYPES)[number];

/**
 * 档案创建/更新入参（判别联合：按 type 分化必填字段）
 * - openai-compatible：baseUrl(url) + model 必填；apiKey 可选（更新时留空保持原值）
 * - trae-cli：command 必填；timeoutMinutes 1-60 可选
 */
export const zAgentProfileInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("openai-compatible"),
    name: z.string().min(1).max(100),
    baseUrl: z.string().url(),
    apiKey: z.string().max(500).optional(),
    model: z.string().min(1),
    systemPrompt: z.string().max(8000).nullable().optional(),
    enableTools: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("trae-cli"),
    name: z.string().min(1).max(100),
    command: z.string().min(1),
    timeoutMinutes: z.number().int().min(1).max(60).optional(),
    systemPrompt: z.string().max(8000).nullable().optional(),
    enableTools: z.boolean().optional(),
  }),
]);

export type AgentProfileInput = z.infer<typeof zAgentProfileInputSchema>;
