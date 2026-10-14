import { z } from "zod";

/**
 * Agent 档案类型：OpenAI 兼容端点 / TraeCode CLI / 宿主型
 * - hosted：宿主型个人 Agent——大脑 = 平台推理 + systemPrompt + knowledgeScope，
 *   无外部连接字段（baseUrl/apiKey/command 恒为 null）
 */
export const AGENT_PROFILE_TYPES = [
  "openai-compatible",
  "trae-cli",
  "hosted",
] as const;
export type AgentProfileType = (typeof AGENT_PROFILE_TYPES)[number];

/**
 * 语料范围：绑定标签/清单构成对外暴露面（D2-c 隐私白名单）。
 * - 本人会话：未设置或两者皆空 = 使用全部书签语料（行为不变）
 * - 对外咨询：未设置或两者皆空 = 默认私有，不注入任何书签/概念页语料
 */
export interface KnowledgeScope {
  tagIds: string[];
  listIds: string[];
}

export const zKnowledgeScopeSchema = z.object({
  tagIds: z.array(z.string()).max(20).default([]),
  listIds: z.array(z.string()).max(20).default([]),
});

/**
 * 档案创建/更新入参（判别联合：按 type 分化必填字段）
 * - openai-compatible：baseUrl(url) + model 必填；apiKey 可选（更新时留空保持原值）
 * - trae-cli：command 必填；timeoutMinutes 1-60 可选
 * - hosted：宿主型个人 Agent，仅人设字段，无连接字段
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
    knowledgeScope: zKnowledgeScopeSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("trae-cli"),
    name: z.string().min(1).max(100),
    command: z.string().min(1),
    timeoutMinutes: z.number().int().min(1).max(60).optional(),
    systemPrompt: z.string().max(8000).nullable().optional(),
    enableTools: z.boolean().optional(),
    knowledgeScope: zKnowledgeScopeSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("hosted"),
    name: z.string().min(1).max(100),
    systemPrompt: z.string().max(8000).nullable().optional(),
    enableTools: z.boolean().optional(),
    knowledgeScope: zKnowledgeScopeSchema.nullable().optional(),
  }),
]);

export type AgentProfileInput = z.infer<typeof zAgentProfileInputSchema>;
