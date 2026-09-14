import { and, count, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

import { agentMemories } from "@saiye/db/schema";
import { z } from "zod";

import { authedProcedure, router } from "../index";

/**
 * B1 长期记忆固化：agent 工具（save/list/delete）与设置页共用。
 * B6 容量管理：存储上限 + 精确去重；注入上限独立（knowledgeRetrieval 的 MEMORY_LIMIT）。
 */
export const MAX_MEMORIES = 100;

export const memoriesAppRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.userId, ctx.user.id))
      .orderBy(desc(agentMemories.createdAt));
    return { memories: rows, capacity: MAX_MEMORIES };
  }),

  create: authedProcedure
    .input(
      z.object({
        content: z.string().min(1).max(2000),
        sourceChatId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // 精确去重：同内容已存在则只刷新时间，不占新容量
      const [existing] = await ctx.db
        .select()
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.userId, ctx.user.id),
            eq(agentMemories.content, input.content),
          ),
        );
      if (existing) {
        const [updated] = await ctx.db
          .update(agentMemories)
          .set({ modifiedAt: new Date() })
          .where(eq(agentMemories.id, existing.id))
          .returning();
        return { ...updated, deduplicated: true };
      }

      // 容量检查：满则拒绝，由调用方（agent 工具/前端）引导清理
      const [{ total }] = await ctx.db
        .select({ total: count() })
        .from(agentMemories)
        .where(eq(agentMemories.userId, ctx.user.id));
      if (total >= MAX_MEMORIES) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `记忆已满（${MAX_MEMORIES}/${MAX_MEMORIES}）。请用 list_memories 查看现有记忆，经用户确认后用 delete_memory 删除不再需要的，再重新保存。`,
        });
      }

      const [memory] = await ctx.db
        .insert(agentMemories)
        .values({
          userId: ctx.user.id,
          content: input.content,
          sourceChatId: input.sourceChatId ?? null,
        })
        .returning();
      return { ...memory, deduplicated: false };
    }),

  update: authedProcedure
    .input(
      z.object({
        id: z.string(),
        content: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(agentMemories)
        .set({ content: input.content })
        .where(
          and(
            eq(agentMemories.id, input.id),
            eq(agentMemories.userId, ctx.user.id),
          ),
        )
        .returning();
      return updated ?? null;
    }),

  delete: authedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(agentMemories)
        .where(
          and(
            eq(agentMemories.id, input.id),
            eq(agentMemories.userId, ctx.user.id),
          ),
        );
      return { success: true };
    }),
});
