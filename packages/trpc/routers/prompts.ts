import { experimental_trpcMiddleware, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { customPrompts } from "@saiye/db/schema";
import {
  zNewPromptSchema,
  zPromptSchema,
  zUpdatePromptSchema,
} from "@saiye/shared/types/prompts";
import {
  buildAssetExportEnvelope,
  zAssetExportEnvelopeSchema,
} from "@saiye/shared/types/assetExport";

import type { AuthedContext, Context } from "../index";
import { createScopedAuthedProcedure, router } from "../index";

const promptsProcedure = createScopedAuthedProcedure("prompts");

export const ensurePromptOwnership = experimental_trpcMiddleware<{
  ctx: Context;
  input: { promptId: string };
}>().create(async (opts) => {
  const prompt = await opts.ctx.db.query.customPrompts.findFirst({
    where: eq(customPrompts.id, opts.input.promptId),
    columns: {
      userId: true,
    },
  });
  if (!opts.ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User is not authorized",
    });
  }
  if (!prompt) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Prompt not found",
    });
  }
  if (prompt.userId != opts.ctx.user.id) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "User is not allowed to access resource",
    });
  }

  return opts.next();
});

export const promptsAppRouter = router({
  create: promptsProcedure
    .input(zNewPromptSchema)
    .output(zPromptSchema)
    .mutation(async ({ input, ctx }) => {
      const [prompt] = await ctx.db
        .insert(customPrompts)
        .values({
          text: input.text,
          appliesTo: input.appliesTo,
          userId: ctx.user.id,
          enabled: true,
        })
        .returning();
      return prompt;
    }),
  update: promptsProcedure
    .input(zUpdatePromptSchema)
    .output(zPromptSchema)
    .use(ensurePromptOwnership)
    .mutation(async ({ input, ctx }) => {
      const res = await ctx.db
        .update(customPrompts)
        .set({
          text: input.text,
          appliesTo: input.appliesTo,
          enabled: input.enabled,
        })
        .where(
          and(
            eq(customPrompts.userId, ctx.user.id),
            eq(customPrompts.id, input.promptId),
          ),
        )
        .returning();
      if (res.length == 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return res[0];
    }),
  list: promptsProcedure
    .output(z.array(zPromptSchema))
    .query(async ({ ctx }) => {
      const prompts = await ctx.db.query.customPrompts.findMany({
        where: eq(customPrompts.userId, ctx.user.id),
      });
      return prompts;
    }),
  delete: promptsProcedure
    .input(
      z.object({
        promptId: z.string(),
      }),
    )
    .use(ensurePromptOwnership)
    .mutation(async ({ input, ctx }) => {
      const res = await ctx.db
        .delete(customPrompts)
        .where(
          and(
            eq(customPrompts.userId, ctx.user.id),
            eq(customPrompts.id, input.promptId),
          ),
        );
      if (res.changes == 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
    }),

  // C1 导出：text/appliesTo/enabled（无敏感字段）
  exportAsset: promptsProcedure
    .input(z.object({ promptId: z.string() }))
    .use(ensurePromptOwnership)
    .mutation(async ({ ctx, input }) => {
      const [prompt] = await ctx.db
        .select({
          text: customPrompts.text,
          appliesTo: customPrompts.appliesTo,
          enabled: customPrompts.enabled,
        })
        .from(customPrompts)
        .where(
          and(
            eq(customPrompts.userId, ctx.user.id),
            eq(customPrompts.id, input.promptId),
          ),
        )
        .limit(1);
      if (!prompt) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return buildAssetExportEnvelope("prompt", prompt);
    }),

  // C1 导入：快照原样落地（enabled 保留导出值）
  importAsset: promptsProcedure
    .input(z.object({ envelope: zAssetExportEnvelopeSchema }))
    .mutation(async ({ ctx, input }) => {
      if (input.envelope.assetType !== "prompt") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This file does not contain a prompt",
        });
      }
      const data = z
        .object({
          text: zNewPromptSchema.shape.text,
          appliesTo: zNewPromptSchema.shape.appliesTo,
          enabled: z.boolean(),
        })
        .safeParse(input.envelope.data);
      if (!data.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid prompt data: ${data.error.message}`,
        });
      }
      return insertImportedPrompt(ctx.db, ctx.user.id, data.data);
    }),
});

/** 落库已校验的 prompt 数据（enabled 保留快照值；C1 importAsset 与 C2 fork 共用） */
export async function insertImportedPrompt(
  db: AuthedContext["db"],
  userId: string,
  data: { text: string; appliesTo: string; enabled: boolean },
) {
  const [prompt] = await db
    .insert(customPrompts)
    .values({
      userId,
      text: data.text,
      // appliesTo 枚举由调用方校验（zNewPromptSchema.shape.appliesTo）
      appliesTo: data.appliesTo as
        | "all_tagging"
        | "text"
        | "images"
        | "summary",
      enabled: data.enabled,
    })
    .returning({ id: customPrompts.id });
  return { id: prompt.id };
}
