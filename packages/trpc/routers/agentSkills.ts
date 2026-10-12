import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  agentProfiles,
  agentPublications,
  agentSkills,
  bookmarkLists,
  bookmarkTags,
} from "@saiye/db/schema";
import {
  zAgentSkillAssetSchema,
  zAgentSkillInputSchema,
} from "@saiye/shared/types/agentSkills";
import { z } from "zod";

import { authedProcedure, router } from "../index";

export const agentSkillsAppRouter = router({
  /** 设置页：某档案下全部技能（含禁用 + 技能级语料范围 + 调用次数） */
  list: authedProcedure
    .input(z.object({ profileId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [profile] = await ctx.db
        .select({ id: agentProfiles.id })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.id, input.profileId),
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
      const skills = await ctx.db
        .select({
          id: agentSkills.id,
          name: agentSkills.name,
          description: agentSkills.description,
          promptTemplate: agentSkills.promptTemplate,
          outputHint: agentSkills.outputHint,
          knowledgeScope: agentSkills.knowledgeScope,
          paramsSchema: agentSkills.paramsSchema,
          // P4 工具授权声明（设置页编辑 + 咨询端授权标识）
          toolGrant: agentSkills.toolGrant,
          enabled: agentSkills.enabled,
          // P2 使用统计：历史调用次数（含禁用期间与已删技能前的记录）
          // 注：不能嵌入 drizzle 列对象——会序列化成裸列名，在子查询里被
          // 绑定到内层表导致恒 false；须手写带表前缀的完整列名
          usageCount: sql<number>`(
            select count(*) from "consultationUsages"
            where "consultationUsages"."skillId" = "agentSkills"."id"
          )`.mapWith(Number),
        })
        .from(agentSkills)
        .where(eq(agentSkills.agentProfileId, input.profileId))
        .orderBy(asc(agentSkills.createdAt));
      return { skills };
    }),

  create: authedProcedure
    .input(zAgentSkillInputSchema.and(z.object({ profileId: z.string() })))
    .mutation(async ({ ctx, input }) => {
      const { profileId, ...rest } = input;
      // 档案归属校验
      const [profile] = await ctx.db
        .select({ id: agentProfiles.id })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.id, profileId),
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
      const [skill] = await ctx.db
        .insert(agentSkills)
        .values({
          userId: ctx.user.id,
          agentProfileId: profileId,
          name: rest.name,
          description: rest.description,
          promptTemplate: rest.promptTemplate,
          outputHint: rest.outputHint ?? null,
          knowledgeScope: rest.knowledgeScope ?? null,
          paramsSchema: rest.paramsSchema ?? null,
          toolGrant: rest.toolGrant ?? null,
          enabled: rest.enabled ?? true,
        })
        .returning();
      return { skill };
    }),

  update: authedProcedure
    .input(zAgentSkillInputSchema.and(z.object({ id: z.string() })))
    .mutation(async ({ ctx, input }) => {
      const { id, ...rest } = input;
      const [updated] = await ctx.db
        .update(agentSkills)
        .set({
          name: rest.name,
          description: rest.description,
          promptTemplate: rest.promptTemplate,
          outputHint: rest.outputHint ?? null,
          knowledgeScope: rest.knowledgeScope ?? null,
          paramsSchema: rest.paramsSchema ?? null,
          toolGrant: rest.toolGrant ?? null,
          enabled: rest.enabled ?? true,
          modifiedAt: new Date(),
        })
        .where(and(eq(agentSkills.id, id), eq(agentSkills.userId, ctx.user.id)))
        .returning();
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }
      return { skill: updated };
    }),

  delete: authedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(agentSkills)
        .where(
          and(
            eq(agentSkills.id, input.id),
            eq(agentSkills.userId, ctx.user.id),
          ),
        );
      return { success: true };
    }),

  /** 咨询端：发布下可被选用的技能（仅 enabled），随发布状态联动 */
  listForConsultation: authedProcedure
    .input(z.object({ publicationId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [publication] = await ctx.db
        .select({
          agentProfileId: agentPublications.agentProfileId,
        })
        .from(agentPublications)
        .where(
          and(
            eq(agentPublications.id, input.publicationId),
            inArray(agentPublications.status, ["published", "delisting"]),
          ),
        )
        .limit(1);
      if (!publication) {
        return { skills: [] };
      }
      const skills = await ctx.db
        .select({
          id: agentSkills.id,
          name: agentSkills.name,
          description: agentSkills.description,
          // P3 参数定义（咨询端渲染填参表单；不含模板正文）
          paramsSchema: agentSkills.paramsSchema,
          // P4 工具授权声明（咨询端渲染授权确认；仅工具名单，无敏感内容）
          toolGrant: agentSkills.toolGrant,
        })
        .from(agentSkills)
        .where(
          and(
            eq(agentSkills.agentProfileId, publication.agentProfileId),
            eq(agentSkills.enabled, true),
          ),
        )
        .orderBy(asc(agentSkills.createdAt));
      return { skills };
    }),

  /**
   * P2 技能导出：跨用户流通的脱敏 JSON——不含内部 id 与 userId；
   * knowledgeScope 的标签/清单以名称迁移（跨用户 id 无意义）。
   */
  exportSkill: authedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [skill] = await ctx.db
        .select()
        .from(agentSkills)
        .where(
          and(
            eq(agentSkills.id, input.id),
            eq(agentSkills.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!skill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }

      // scope id → 名称（仅本人名下能 join 到；悬空 id 自然丢弃）
      let scope: { tagNames: string[]; listNames: string[] } | null = null;
      if (
        skill.knowledgeScope &&
        (skill.knowledgeScope.tagIds.length > 0 ||
          skill.knowledgeScope.listIds.length > 0)
      ) {
        const tagRows =
          skill.knowledgeScope.tagIds.length > 0
            ? await ctx.db
                .select({ name: bookmarkTags.name })
                .from(bookmarkTags)
                .where(
                  and(
                    inArray(bookmarkTags.id, skill.knowledgeScope.tagIds),
                    eq(bookmarkTags.userId, ctx.user.id),
                  ),
                )
            : [];
        const listRows =
          skill.knowledgeScope.listIds.length > 0
            ? await ctx.db
                .select({ name: bookmarkLists.name })
                .from(bookmarkLists)
                .where(
                  and(
                    inArray(bookmarkLists.id, skill.knowledgeScope.listIds),
                    eq(bookmarkLists.userId, ctx.user.id),
                  ),
                )
            : [];
        scope = {
          tagNames: tagRows.map((r) => r.name),
          listNames: listRows.map((r) => r.name),
        };
      }

      return {
        asset: {
          version: 1 as const,
          name: skill.name,
          description: skill.description,
          promptTemplate: skill.promptTemplate,
          outputHint: skill.outputHint,
          knowledgeScope: scope,
          paramsSchema: skill.paramsSchema ?? null,
          toolGrant: skill.toolGrant ?? null,
        },
      };
    }),

  /**
   * P2 技能导入：挂到指定档案；knowledgeScope 按名称在导入者名下
   * 重匹配（精确匹配，匹配不到的名称丢弃）。
   */
  importSkill: authedProcedure
    .input(
      z.object({
        profileId: z.string(),
        asset: zAgentSkillAssetSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [profile] = await ctx.db
        .select({ id: agentProfiles.id })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.id, input.profileId),
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

      // 名称重匹配：精确名称 → 导入者名下 id；未命中的丢弃
      let scope: { tagIds: string[]; listIds: string[] } | null = null;
      const assetScope = input.asset.knowledgeScope;
      if (
        assetScope &&
        (assetScope.tagNames.length > 0 || assetScope.listNames.length > 0)
      ) {
        const tagRows =
          assetScope.tagNames.length > 0
            ? await ctx.db
                .select({ id: bookmarkTags.id })
                .from(bookmarkTags)
                .where(
                  and(
                    inArray(bookmarkTags.name, assetScope.tagNames),
                    eq(bookmarkTags.userId, ctx.user.id),
                  ),
                )
            : [];
        const listRows =
          assetScope.listNames.length > 0
            ? await ctx.db
                .select({ id: bookmarkLists.id })
                .from(bookmarkLists)
                .where(
                  and(
                    inArray(bookmarkLists.name, assetScope.listNames),
                    eq(bookmarkLists.userId, ctx.user.id),
                  ),
                )
            : [];
        const tagIds = tagRows.map((r) => r.id);
        const listIds = listRows.map((r) => r.id);
        if (tagIds.length > 0 || listIds.length > 0) {
          scope = { tagIds, listIds };
        }
      }

      const [skill] = await ctx.db
        .insert(agentSkills)
        .values({
          userId: ctx.user.id,
          agentProfileId: input.profileId,
          name: input.asset.name,
          description: input.asset.description,
          promptTemplate: input.asset.promptTemplate,
          outputHint: input.asset.outputHint,
          knowledgeScope: scope,
          paramsSchema: input.asset.paramsSchema ?? null,
          toolGrant: input.asset.toolGrant ?? null,
          enabled: true,
        })
        .returning();
      return { skill };
    }),
});
