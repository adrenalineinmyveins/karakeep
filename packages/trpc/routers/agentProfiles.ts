import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";

import { agentProfiles, agentPublications } from "@saiye/db/schema";
import {
  zAgentProfileInputSchema,
  zKnowledgeScopeSchema,
} from "@saiye/shared/types/agentProfiles";
import {
  buildAssetExportEnvelope,
  zAssetExportEnvelopeSchema,
} from "@saiye/shared/types/assetExport";
import { z } from "zod";

import type { AuthedContext } from "../index";
import { authedProcedure, router } from "../index";

/** 返回给前端的列（不含 apiKey，只暴露是否已配置） */
const safeColumns = {
  id: agentProfiles.id,
  name: agentProfiles.name,
  type: agentProfiles.type,
  baseUrl: agentProfiles.baseUrl,
  model: agentProfiles.model,
  command: agentProfiles.command,
  timeoutMinutes: agentProfiles.timeoutMinutes,
  systemPrompt: agentProfiles.systemPrompt,
  enableTools: agentProfiles.enableTools,
  knowledgeScope: agentProfiles.knowledgeScope,
  hasApiKey: agentProfiles.apiKey,
};

/** 按 type 落列（判别联合分化字段） */
function toValues(input: z.infer<typeof zAgentProfileInputSchema>) {
  return {
    name: input.name,
    type: input.type,
    systemPrompt: input.systemPrompt ?? null,
    enableTools: input.enableTools ?? true,
    knowledgeScope: input.knowledgeScope ?? null,
    ...(input.type === "openai-compatible"
      ? {
          baseUrl: input.baseUrl,
          model: input.model,
          command: null,
          timeoutMinutes: 5,
        }
      : input.type === "hosted"
        ? {
            // 宿主型：无连接字段，大脑由平台推理承担
            baseUrl: null,
            apiKey: null,
            model: null,
            command: null,
            timeoutMinutes: 5,
          }
        : {
            baseUrl: null,
            apiKey: null,
            model: null,
            command: input.command,
            timeoutMinutes: input.timeoutMinutes ?? 5,
          }),
  };
}

export const agentProfilesAppRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select(safeColumns)
      .from(agentProfiles)
      .where(eq(agentProfiles.userId, ctx.user.id))
      .orderBy(asc(agentProfiles.createdAt));
    return {
      profiles: rows.map((r) => ({
        ...r,
        hasApiKey: r.hasApiKey !== null && r.hasApiKey.length > 0,
      })),
    };
  }),

  create: authedProcedure
    .input(zAgentProfileInputSchema)
    .mutation(async ({ ctx, input }) => {
      // openai-compatible 型必须有 apiKey 才能用
      if (input.type === "openai-compatible" && !input.apiKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "API key is required for openai-compatible profiles",
        });
      }
      const [profile] = await ctx.db
        .insert(agentProfiles)
        .values({
          userId: ctx.user.id,
          ...toValues(input),
          ...(input.type === "openai-compatible"
            ? { apiKey: input.apiKey }
            : {}),
        })
        .returning(safeColumns);
      return { ...profile, hasApiKey: true };
    }),

  update: authedProcedure
    .input(
      zAgentProfileInputSchema.and(
        z.object({ id: z.string(), apiKey: z.string().optional() }),
      ),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, apiKey, ...rest } = input;
      // 归属校验
      const [existing] = await ctx.db
        .select({ id: agentProfiles.id })
        .from(agentProfiles)
        .where(
          and(eq(agentProfiles.id, id), eq(agentProfiles.userId, ctx.user.id)),
        )
        .limit(1);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Agent profile not found",
        });
      }

      // apiKey 留空 = 保持原值（前端编辑时不回显密钥）
      const values: Record<string, unknown> = {
        ...toValues(rest),
        modifiedAt: new Date(),
      };
      if (apiKey) {
        values.apiKey = apiKey;
      }

      const [updated] = await ctx.db
        .update(agentProfiles)
        .set(values)
        .where(
          and(eq(agentProfiles.id, id), eq(agentProfiles.userId, ctx.user.id)),
        )
        .returning(safeColumns);
      return {
        ...updated,
        hasApiKey: updated.hasApiKey !== null && updated.hasApiKey.length > 0,
      };
    }),

  delete: authedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // D1：存在未彻底下架的发布时禁止删除（防绕过下架缓冲期）
      const [activePublication] = await ctx.db
        .select({ id: agentPublications.id })
        .from(agentPublications)
        .where(
          and(
            eq(agentPublications.agentProfileId, input.id),
            inArray(agentPublications.status, ["published", "delisting"]),
          ),
        )
        .limit(1);
      if (activePublication) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This profile is published as a domain expert. Delist it (including the grace period) before deleting.",
        });
      }
      // 会话上的 FK 是 set null，直接删即可
      await ctx.db
        .delete(agentProfiles)
        .where(
          and(
            eq(agentProfiles.id, input.id),
            eq(agentProfiles.userId, ctx.user.id),
          ),
        );
      return { success: true };
    }),

  // 一键创建宿主型个人 Agent 并发布（档案 + 卡片单事务落库）
  publishAsAgent: authedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        systemPrompt: z.string().max(8000).nullable().optional(),
        enableTools: z.boolean().optional(),
        knowledgeScope: zKnowledgeScopeSchema.nullable().optional(),
        title: z.string().min(1).max(120).optional(),
        description: z.string().max(2000).optional(),
        tags: z.array(z.string().min(1).max(40)).max(10).optional(),
        pricePerCall: z.number().int().min(0).max(100_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return await ctx.db.transaction(async (tx) => {
        const [profile] = await tx
          .insert(agentProfiles)
          .values({
            userId: ctx.user.id,
            ...toValues({
              type: "hosted",
              name: input.name,
              systemPrompt: input.systemPrompt,
              enableTools: input.enableTools,
              knowledgeScope: input.knowledgeScope,
            }),
          })
          .returning({ id: agentProfiles.id });
        const [publication] = await tx
          .insert(agentPublications)
          .values({
            userId: ctx.user.id,
            agentProfileId: profile!.id,
            title: input.title ?? input.name,
            description: input.description ?? null,
            tags: input.tags ?? [],
            pricePerCall: input.pricePerCall ?? 0,
          })
          .returning();
        return { profileId: profile!.id, publication };
      });
    }),

  // C1 导出：apiKey 永不导出（导入后需自行补填）
  exportAsset: authedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [profile] = await ctx.db
        .select({
          name: agentProfiles.name,
          type: agentProfiles.type,
          baseUrl: agentProfiles.baseUrl,
          model: agentProfiles.model,
          command: agentProfiles.command,
          timeoutMinutes: agentProfiles.timeoutMinutes,
          systemPrompt: agentProfiles.systemPrompt,
          enableTools: agentProfiles.enableTools,
          knowledgeScope: agentProfiles.knowledgeScope,
        })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.id, input.id),
            eq(agentProfiles.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Agent profile not found",
        });
      }
      return buildAssetExportEnvelope("agentProfile", profile);
    }),

  // C1 导入：校验信封与 data 后新建（apiKey 为空，openai-compatible 需补填才能用）
  importAsset: authedProcedure
    .input(z.object({ envelope: zAssetExportEnvelopeSchema }))
    .mutation(async ({ ctx, input }) => {
      if (input.envelope.assetType !== "agentProfile") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This file does not contain an agent profile",
        });
      }
      const data = zAgentProfileInputSchema.safeParse(input.envelope.data);
      if (!data.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid agent profile data: ${data.error.message}`,
        });
      }
      return insertImportedAgentProfile(ctx.db, ctx.user.id, data.data);
    }),
});

/** 落库已校验的档案数据（apiKey 为空；C1 importAsset 与 C2 fork 共用） */
export async function insertImportedAgentProfile(
  db: AuthedContext["db"],
  userId: string,
  data: z.infer<typeof zAgentProfileInputSchema>,
) {
  const [profile] = await db
    .insert(agentProfiles)
    .values({
      userId,
      ...toValues(data),
    })
    .returning({ id: agentProfiles.id });
  return {
    id: profile.id,
    needsApiKey: data.type === "openai-compatible",
  };
}
