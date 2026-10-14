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
 * D2-b 喂养增量游标（ProfileConsumer 模式）：
 * lastCursor = 已喂养到的书签 modifiedAt（ISO 串）——只处理游标之后的变更，
 * 避免全量轮询；喂养批次与触发评估共用此游标。
 */
export interface AgentNurtureState {
  lastCursor: string | null;
  lastRunAt: number;
  runsCount: number;
}

/**
 * D1 在线状态：外部大脑（openai-compatible）探活结果。
 * hosted 型平台恒在线（不落库）；trae-cli 型运行在所有者本地（不可探，恒 unknown）。
 */
export interface AgentOnlineState {
  state: "online" | "offline";
  checkedAt: number;
}

/** D2 喂养产物入参（三个 union 分支共用） */
const zNurtureFields = {
  // LLM 生成的第三人称能力简介；用户编辑后应同时提交 nurtureAuto: false
  bio: z.string().max(500).nullable().optional(),
  expertiseTags: z
    .array(z.string().min(1).max(30))
    .max(8)
    .nullable()
    .optional(),
  // true = nurture worker 持续自动刷新 bio/专长标签；用户手工修正后置 false
  nurtureAuto: z.boolean().optional(),
};

/**
 * 档案创建/更新入参（判别联合：按 type 分化必填字段）
 * - openai-compatible：baseUrl(url) + model 必填；apiKey 可选（更新时留空保持原值）
 * - trae-cli：command 必填；timeoutMinutes 1-60 可选
 * - hosted：宿主型个人 Agent，仅人设字段，无连接字段
 */
export const zAgentProfileInputSchema = z.discriminatedUnion("type", [
  z.object({
    ...zNurtureFields,
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
    ...zNurtureFields,
    type: z.literal("trae-cli"),
    name: z.string().min(1).max(100),
    command: z.string().min(1),
    timeoutMinutes: z.number().int().min(1).max(60).optional(),
    systemPrompt: z.string().max(8000).nullable().optional(),
    enableTools: z.boolean().optional(),
    knowledgeScope: zKnowledgeScopeSchema.nullable().optional(),
  }),
  z.object({
    ...zNurtureFields,
    type: z.literal("hosted"),
    name: z.string().min(1).max(100),
    systemPrompt: z.string().max(8000).nullable().optional(),
    enableTools: z.boolean().optional(),
    knowledgeScope: zKnowledgeScopeSchema.nullable().optional(),
  }),
]);

export type AgentProfileInput = z.infer<typeof zAgentProfileInputSchema>;
