import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  agentPosts,
  agentProfiles,
  agentPublications,
  feedImpressions,
} from "@saiye/db/schema";

import { authedProcedure, router } from "../index";
import { settleExpiredDelistings } from "./agentPublications";

/**
 * D6 发现流：内容池 = agentPublications（技能卡片）+ agentPosts（动态），
 * 按 createdAt 倒序混排；曝光去重（feedImpressions，验收：连续刷新
 * 3 次不出现重复曝光），动态条目带 publicationId 时可跳转专家卡片。
 */

const zAgentPostSchema = z.object({
  id: z.string(),
  userId: z.string(),
  profileId: z.string(),
  publicationId: z.string().nullable(),
  content: z.string(),
  createdAt: z.date().nullable(),
  modifiedAt: z.date().nullable(),
});

const zFeedItemSchema = z.object({
  itemType: z.enum(["publication", "post"]),
  itemId: z.string(),
  // publication：发布标题；post：作者 Agent 名
  title: z.string(),
  content: z.string().nullable(),
  // D2 喂养画像（publication 条目带；post 条目带所属档案的）
  bio: z.string().nullable(),
  expertiseTags: z.array(z.string()).nullable(),
  ownerName: z.string(),
  // 跳转专家卡片用（publication 条目 = 自身；post 条目 = 可选关联）
  publicationId: z.string().nullable(),
  isOwn: z.boolean(),
  createdAt: z.date(),
});

// offset 型 cursor（同 agentMessages 分页惯例）
const zFeedInputSchema = z.object({
  cursor: z.number().int().min(0).nullish(),
  limit: z.number().int().min(1).max(50).nullish(),
});

export const agentFeedAppRouter = router({
  /**
   * 拉取发现流一页：排除该用户已曝光条目，返回后批量落曝光
   * （幂等合并）。分页采用「曝光推进」：每页都从池顶拉取，返回过的
   * 条目立即记曝光、下页自动排除——offset 语义在曝光排除下会错位漏条，
   * 而 cursor 恒 0 让 infiniteQuery 的"下一页"自然推进。池耗尽返回空页。
   */
  feed: authedProcedure
    .input(zFeedInputSchema)
    .output(
      z.object({
        items: z.array(zFeedItemSchema),
        nextCursor: z.number().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await settleExpiredDelistings(ctx.db);
      const limit = input.limit ?? 20;

      // 内容池 union（skills + 动态）按 createdAt 倒序；NOT EXISTS 排除已曝光。
      // 两个条目源的展示字段统一成 FeedItem 形状。
      const result = await ctx.db.execute(sql`
        SELECT * FROM (
          SELECT
            'publication'::text AS "itemType",
            pub."id"::text AS "itemId",
            pub."title" AS "title",
            pub."description" AS "content",
            prof."bio" AS "bio",
            prof."expertise_tags" AS "expertiseTags",
            u."name" AS "ownerName",
            pub."id" AS "publicationId",
            (pub."userId" = ${ctx.user.id}) AS "isOwn",
            pub."createdAt" AS "createdAt"
          FROM "agentPublications" pub
          JOIN "agentProfiles" prof ON prof."id" = pub."agentProfileId"
          JOIN "user" u ON u."id" = pub."userId"
          WHERE pub."status" IN ('published', 'delisting')
            AND NOT EXISTS (
              SELECT 1 FROM "feedImpressions" fi
              WHERE fi."userId" = ${ctx.user.id}
                AND fi."itemType" = 'publication'
                AND fi."itemId" = pub."id"
            )
          UNION ALL
          SELECT
            'post'::text AS "itemType",
            ap."id"::text AS "itemId",
            prof."name" AS "title",
            ap."content" AS "content",
            prof."bio" AS "bio",
            prof."expertise_tags" AS "expertiseTags",
            u."name" AS "ownerName",
            ap."publicationId" AS "publicationId",
            (ap."userId" = ${ctx.user.id}) AS "isOwn",
            ap."createdAt" AS "createdAt"
          FROM "agentPosts" ap
          JOIN "agentProfiles" prof ON prof."id" = ap."profileId"
          JOIN "user" u ON u."id" = ap."userId"
          WHERE NOT EXISTS (
              SELECT 1 FROM "feedImpressions" fi
              WHERE fi."userId" = ${ctx.user.id}
                AND fi."itemType" = 'post'
                AND fi."itemId" = ap."id"
            )
        ) feed
        ORDER BY "createdAt" DESC
        LIMIT ${limit + 1}
      `);
      const rows = (
        result as unknown as {
          rows: {
            itemType: "publication" | "post";
            itemId: string;
            title: string;
            content: string | null;
            bio: string | null;
            expertiseTags: string[] | null;
            ownerName: string | null;
            publicationId: string | null;
            isOwn: boolean;
            createdAt: string | Date;
          }[];
        }
      ).rows;

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
        ...r,
        ownerName: r.ownerName ?? "",
        createdAt: new Date(r.createdAt),
      }));

      // 曝光落库（幂等合并；失败不阻断返回——去重是体验优化非硬约束）
      if (items.length > 0) {
        await ctx.db
          .insert(feedImpressions)
          .values(
            items.map((it) => ({
              userId: ctx.user.id,
              itemType: it.itemType,
              itemId: it.itemId,
            })),
          )
          .onConflictDoNothing();
      }

      // 曝光推进：还有剩余就再给一轮（cursor 恒 0），池耗尽返回 null
      return {
        items,
        nextCursor: hasMore ? 0 : null,
      };
    }),

  // 发布动态（Feed 内容池的"动态"形态）：校验档案归属 + 关联发布归属
  createPost: authedProcedure
    .input(
      z.object({
        profileId: z.string(),
        content: z.string().min(1).max(2000),
        publicationId: z.string().optional(),
      }),
    )
    .output(z.object({ post: zAgentPostSchema }))
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
      if (input.publicationId) {
        const [pub] = await ctx.db
          .select({ id: agentPublications.id })
          .from(agentPublications)
          .where(
            and(
              eq(agentPublications.id, input.publicationId),
              eq(agentPublications.userId, ctx.user.id),
            ),
          )
          .limit(1);
        if (!pub) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Publication not found",
          });
        }
      }

      const [post] = await ctx.db
        .insert(agentPosts)
        .values({
          userId: ctx.user.id,
          profileId: input.profileId,
          publicationId: input.publicationId ?? null,
          content: input.content,
        })
        .returning();
      return { post: post! };
    }),

  // 我的动态（发动态入口回显/删除用）
  listMyPosts: authedProcedure
    .output(z.object({ posts: z.array(zAgentPostSchema) }))
    .query(async ({ ctx }) => {
      const posts = await ctx.db
        .select()
        .from(agentPosts)
        .where(eq(agentPosts.userId, ctx.user.id))
        .orderBy(desc(agentPosts.createdAt))
        .limit(50);
      return { posts };
    }),

  deletePost: authedProcedure
    .input(z.object({ id: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(agentPosts)
        .where(
          and(eq(agentPosts.id, input.id), eq(agentPosts.userId, ctx.user.id)),
        );
      return { success: true };
    }),
});
