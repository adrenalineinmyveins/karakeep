import { z } from "zod";

import { zKnowledgeScopeSchema } from "./agentProfiles";

/**
 * P3 参数化技能：单个参数定义。
 * - name：占位符名（模板中以 {{name}} 引用），限字母/数字/下划线
 * - type：string / number / boolean / enum 四种（P3 不做嵌套对象/数组）
 * - enum 类型必须提供 options（refine 校验）
 * - required 缺省为 false；default 为该参数缺省值
 */
export const zSkillParamSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    label: z.string().min(1).max(100),
    type: z.enum(["string", "number", "boolean", "enum"]),
    required: z.boolean().optional(),
    options: z.array(z.string().min(1).max(100)).max(20).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .refine((p) => p.type !== "enum" || (p.options?.length ?? 0) > 0, {
    message: "enum parameter requires options",
    path: ["options"],
  });

export type SkillParam = z.infer<typeof zSkillParamSchema>;

/** 参数定义数组（≤10 个；name 唯一） */
export const zSkillParamsSchema = z
  .array(zSkillParamSchema)
  .max(10)
  .refine(
    (params) => new Set(params.map((p) => p.name)).size === params.length,
    {
      message: "duplicate parameter name",
    },
  );

/** 咨询者填写的参数值（按定义校验后使用） */
export const zSkillParamValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export type SkillParamValues = z.infer<typeof zSkillParamValuesSchema>;

/**
 * P4 工具执行型技能：可授权给技能的工具白名单（服务端硬校验，
 * 不接受任意工具名）。初始仅低危写工具（产物强制归属咨询者）。
 */
export const SKILL_GRANTABLE_TOOLS = ["save_widget", "update_widget"] as const;

export type SkillGrantableTool = (typeof SKILL_GRANTABLE_TOOLS)[number];

/**
 * P4 工具授权声明：技能点选后当轮临时解锁白名单工具。
 * confirmRequired：P4 语义为「点选技能时需咨询者显式授权确认」
 * （发送前一次性授权；未来如需逐次确认门在此字段上扩展）。
 */
export const zSkillToolGrantSchema = z.object({
  tools: z
    .array(z.enum(SKILL_GRANTABLE_TOOLS))
    .min(1)
    .max(SKILL_GRANTABLE_TOOLS.length),
  confirmRequired: z.boolean().default(true),
});

export type SkillToolGrant = z.infer<typeof zSkillToolGrantSchema>;

/**
 * 技能创建/更新入参
 * - name/description/promptTemplate 必填；outputHint 可选
 * - knowledgeScope：P2 技能级语料范围（点选当轮与档案 scope 取交集）
 * - paramsSchema：P3 参数定义（null = 无参提示词模板型）
 * - toolGrant：P4 工具授权（null = 纯提示词技能，不解锁任何工具）
 */
export const zAgentSkillInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  promptTemplate: z.string().min(1).max(4000),
  outputHint: z.string().max(500).nullable().optional(),
  knowledgeScope: zKnowledgeScopeSchema.nullable().optional(),
  paramsSchema: zSkillParamsSchema.nullable().optional(),
  toolGrant: zSkillToolGrantSchema.nullable().optional(),
  enabled: z.boolean().optional(),
});

export type AgentSkillInput = z.infer<typeof zAgentSkillInputSchema>;

/**
 * 技能导入资产（P2 复用）：跨用户流通的脱敏形态——
 * 不含内部 id；knowledgeScope 以名称迁移（导入时按名称重匹配）；
 * paramsSchema 随资产原样流通（P3）
 */
export const zAgentSkillAssetSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  promptTemplate: z.string().min(1).max(4000),
  outputHint: z.string().max(500).nullable(),
  knowledgeScope: z
    .object({
      tagNames: z.array(z.string().max(100)).max(20),
      listNames: z.array(z.string().max(100)).max(20),
    })
    .nullable(),
  paramsSchema: zSkillParamsSchema.nullable(),
  toolGrant: zSkillToolGrantSchema.nullable(),
});

export type AgentSkillAsset = z.infer<typeof zAgentSkillAssetSchema>;
