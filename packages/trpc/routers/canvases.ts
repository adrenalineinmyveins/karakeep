import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@saiye/db";
import { canvases } from "@saiye/db/schema";

import { authedProcedure, router } from "../index";

export const canvasesAppRouter = router({
  // 创建画布
  createCanvas: authedProcedure
    .input(
      z.object({
        title: z.string().optional(),
        data: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [created] = await db
        .insert(canvases)
        .values({
          userId: ctx.user.id,
          title: input.title ?? "未命名画布",
          data: input.data ?? [],
        })
        .returning();
      return created;
    }),

  // 列出当前用户的画布
  listCanvases: authedProcedure.query(async ({ ctx }) => {
    return await db
      .select({
        id: canvases.id,
        title: canvases.title,
        createdAt: canvases.createdAt,
        modifiedAt: canvases.modifiedAt,
      })
      .from(canvases)
      .where(eq(canvases.userId, ctx.user.id))
      .orderBy(desc(canvases.modifiedAt));
  }),

  // 获取画布详情（含 drawnix 元素数据）
  getCanvas: authedProcedure
    .input(z.object({ canvasId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [found] = await db
        .select()
        .from(canvases)
        .where(
          and(
            eq(canvases.id, input.canvasId),
            eq(canvases.userId, ctx.user.id),
          ),
        )
        .limit(1);

      if (!found) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found" });
      }
      return found;
    }),

  // 更新画布（标题和/或元素数据），总是刷新 modifiedAt
  updateCanvas: authedProcedure
    .input(
      z.object({
        canvasId: z.string(),
        title: z.string().optional(),
        data: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: {
        modifiedAt: Date;
        title?: string;
        data?: unknown;
      } = { modifiedAt: new Date() };
      if (input.title !== undefined) {
        patch.title = input.title;
      }
      if (input.data !== undefined) {
        patch.data = input.data;
      }

      const [updated] = await db
        .update(canvases)
        .set(patch)
        .where(
          and(
            eq(canvases.id, input.canvasId),
            eq(canvases.userId, ctx.user.id),
          ),
        )
        .returning();

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found" });
      }
      return updated;
    }),

  // 删除画布
  deleteCanvas: authedProcedure
    .input(z.object({ canvasId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await db
        .delete(canvases)
        .where(
          and(
            eq(canvases.id, input.canvasId),
            eq(canvases.userId, ctx.user.id),
          ),
        )
        .returning({ id: canvases.id });

      if (deleted.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Canvas not found" });
      }
      return { success: true };
    }),
});
