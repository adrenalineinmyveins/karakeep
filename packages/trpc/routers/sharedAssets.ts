import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, lt, lte, or } from "drizzle-orm";
import { z } from "zod";

import {
  agentProfiles,
  customPrompts,
  sharedAgentAssets,
  users,
  widgets,
} from "@saiye/db/schema";
import { zAgentProfileInputSchema } from "@saiye/shared/types/agentProfiles";
import { ASSET_EXPORT_TYPES } from "@saiye/shared/types/assetExport";
import { zCursorV2 } from "@saiye/shared/types/pagination";
import { zNewPromptSchema } from "@saiye/shared/types/prompts";
import { zWidgetManifestSchema } from "@saiye/shared/types/widgets";

import type { AuthedContext } from "../index";
import { authedProcedure, publicProcedure, router } from "../index";
import { insertImportedAgentProfile } from "./agentProfiles";
import { insertImportedPrompt } from "./prompts";
import { insertDraftWidget } from "./widgets";

/**
 * C2 分享链接 + Fork。
 *
 * 分享 = 快照：create 时从源资产复制数据（与 C1 导出信封 data 同构，
 * apiKey 永不入快照），源资产后续修改/删除不影响已分享内容。
 * revoke = 删除行，链接即失效。
 */

const zWidgetPayloadSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable(),
  manifest: zWidgetManifestSchema,
  code: z.string().min(1),
});

const zPromptPayloadSchema = z.object({
  text: zNewPromptSchema.shape.text,
  appliesTo: zNewPromptSchema.shape.appliesTo,
  enabled: z.boolean(),
});

/** 按类型读取源资产并生成快照（归属校验 + apiKey 脱敏） */
async function snapshotAsset(
  db: AuthedContext["db"],
  userId: string,
  assetType: (typeof ASSET_EXPORT_TYPES)[number],
  assetId: string,
): Promise<{ name: string; payload: unknown }> {
  switch (assetType) {
    case "agentProfile": {
      const [profile] = await db
        .select({
          name: agentProfiles.name,
          type: agentProfiles.type,
          baseUrl: agentProfiles.baseUrl,
          model: agentProfiles.model,
          command: agentProfiles.command,
          timeoutMinutes: agentProfiles.timeoutMinutes,
          systemPrompt: agentProfiles.systemPrompt,
          enableTools: agentProfiles.enableTools,
        })
        .from(agentProfiles)
        .where(
          and(eq(agentProfiles.id, assetId), eq(agentProfiles.userId, userId)),
        )
        .limit(1);
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Agent profile not found",
        });
      }
      return { name: profile.name, payload: profile };
    }
    case "widget": {
      const [widget] = await db
        .select({
          name: widgets.name,
          description: widgets.description,
          manifest: widgets.manifest,
          code: widgets.code,
        })
        .from(widgets)
        .where(and(eq(widgets.id, assetId), eq(widgets.userId, userId)))
        .limit(1);
      if (!widget) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Widget not found" });
      }
      return { name: widget.name, payload: widget };
    }
    case "prompt": {
      const [prompt] = await db
        .select({
          text: customPrompts.text,
          appliesTo: customPrompts.appliesTo,
          enabled: customPrompts.enabled,
        })
        .from(customPrompts)
        .where(
          and(eq(customPrompts.id, assetId), eq(customPrompts.userId, userId)),
        )
        .limit(1);
      if (!prompt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Prompt not found" });
      }
      return { name: prompt.text.slice(0, 50), payload: prompt };
    }
  }
}

/** 快照 payload 校验失败时的统一报错 */
function invalidPayload(assetType: string): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: `Invalid ${assetType} payload in shared asset`,
  });
}

export const sharedAssetsAppRouter = router({
  // 创建分享（幂等：同资产已有分享则返回现有 token）
  create: authedProcedure
    .input(
      z.object({
        assetType: z.enum(ASSET_EXPORT_TYPES),
        assetId: z.string(),
      }),
    )
    .output(z.object({ shareToken: z.string(), name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({
          shareToken: sharedAgentAssets.shareToken,
          name: sharedAgentAssets.name,
        })
        .from(sharedAgentAssets)
        .where(
          and(
            eq(sharedAgentAssets.userId, ctx.user.id),
            eq(sharedAgentAssets.assetType, input.assetType),
            eq(sharedAgentAssets.assetId, input.assetId),
          ),
        )
        .limit(1);
      if (existing) {
        return existing;
      }

      const { name, payload } = await snapshotAsset(
        ctx.db,
        ctx.user.id,
        input.assetType,
        input.assetId,
      );

      const [created] = await ctx.db
        .insert(sharedAgentAssets)
        .values({
          userId: ctx.user.id,
          assetType: input.assetType,
          assetId: input.assetId,
          shareToken: randomBytes(32).toString("hex"),
          name,
          payload,
        })
        .returning({ shareToken: sharedAgentAssets.shareToken });
      return { shareToken: created.shareToken, name };
    }),

  // 我分享的资产列表
  listMine: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: sharedAgentAssets.id,
        assetType: sharedAgentAssets.assetType,
        assetId: sharedAgentAssets.assetId,
        shareToken: sharedAgentAssets.shareToken,
        name: sharedAgentAssets.name,
        createdAt: sharedAgentAssets.createdAt,
      })
      .from(sharedAgentAssets)
      .where(eq(sharedAgentAssets.userId, ctx.user.id))
      .orderBy(desc(sharedAgentAssets.createdAt));
    return { shares: rows };
  }),

  // C3 发现页：实例内全部有效分享（登录可见，带类型筛选 + 关键词搜索 + cursor 分页）
  listPublic: authedProcedure
    .input(
      z.object({
        assetType: z.enum(ASSET_EXPORT_TYPES).optional(),
        query: z.string().max(100).optional(),
        cursor: zCursorV2.nullish(),
        limit: z.number().min(1).max(50).default(20),
      }),
    )
    .output(
      z.object({
        assets: z.array(
          z.object({
            shareToken: z.string(),
            assetType: z.enum(ASSET_EXPORT_TYPES),
            name: z.string(),
            ownerName: z.string(),
            isMine: z.boolean(),
            createdAt: z.date(),
          }),
        ),
        nextCursor: zCursorV2.nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const results = await ctx.db
        .select({
          id: sharedAgentAssets.id,
          shareToken: sharedAgentAssets.shareToken,
          assetType: sharedAgentAssets.assetType,
          name: sharedAgentAssets.name,
          createdAt: sharedAgentAssets.createdAt,
          ownerId: sharedAgentAssets.userId,
          ownerName: users.name,
        })
        .from(sharedAgentAssets)
        .innerJoin(users, eq(users.id, sharedAgentAssets.userId))
        .where(
          and(
            input.assetType
              ? eq(sharedAgentAssets.assetType, input.assetType)
              : undefined,
            input.query
              ? like(sharedAgentAssets.name, `%${input.query}%`)
              : undefined,
            input.cursor
              ? or(
                  lt(sharedAgentAssets.createdAt, input.cursor.createdAt),
                  and(
                    eq(sharedAgentAssets.createdAt, input.cursor.createdAt),
                    lte(sharedAgentAssets.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(sharedAgentAssets.createdAt), desc(sharedAgentAssets.id))
        .limit(input.limit + 1);

      let nextCursor: z.infer<typeof zCursorV2> | null = null;
      if (results.length > input.limit) {
        const nextItem = results.pop()!;
        nextCursor = { id: nextItem.id, createdAt: nextItem.createdAt };
      }
      return {
        assets: results.map((row) => ({
          shareToken: row.shareToken,
          assetType: row.assetType,
          name: row.name,
          ownerName: row.ownerName,
          createdAt: row.createdAt,
          isMine: row.ownerId === ctx.user.id,
        })),
        nextCursor,
      };
    }),

  // 撤销分享（删除行，链接即失效）
  revoke: authedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const res = await ctx.db
        .delete(sharedAgentAssets)
        .where(
          and(
            eq(sharedAgentAssets.id, input.id),
            eq(sharedAgentAssets.userId, ctx.user.id),
          ),
        );
      if (res.changes == 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Shared asset not found",
        });
      }
    }),

  // 一键 fork：把分享快照复制为当前用户的资产
  fork: authedProcedure
    .input(z.object({ token: z.string() }))
    .output(
      z.object({
        assetType: z.enum(ASSET_EXPORT_TYPES),
        assetId: z.string(),
        needsApiKey: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [share] = await ctx.db
        .select({
          assetType: sharedAgentAssets.assetType,
          payload: sharedAgentAssets.payload,
        })
        .from(sharedAgentAssets)
        .where(eq(sharedAgentAssets.shareToken, input.token))
        .limit(1);
      if (!share) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Shared asset not found",
        });
      }

      switch (share.assetType) {
        case "agentProfile": {
          const data = zAgentProfileInputSchema.safeParse(share.payload);
          if (!data.success) {
            throw invalidPayload("agent profile");
          }
          const res = await insertImportedAgentProfile(
            ctx.db,
            ctx.user.id,
            data.data,
          );
          return {
            assetType: "agentProfile" as const,
            assetId: res.id,
            needsApiKey: res.needsApiKey,
          };
        }
        case "widget": {
          const data = zWidgetPayloadSchema.safeParse(share.payload);
          if (!data.success) {
            throw invalidPayload("widget");
          }
          const res = await insertDraftWidget(ctx.db, ctx.user.id, data.data);
          return {
            assetType: "widget" as const,
            assetId: res.id,
            needsApiKey: false,
          };
        }
        case "prompt": {
          const data = zPromptPayloadSchema.safeParse(share.payload);
          if (!data.success) {
            throw invalidPayload("prompt");
          }
          const res = await insertImportedPrompt(
            ctx.db,
            ctx.user.id,
            data.data,
          );
          return {
            assetType: "prompt" as const,
            assetId: res.id,
            needsApiKey: false,
          };
        }
      }
    }),
});

export const publicSharedAssets = router({
  // 公开读取分享（无登录，按 token）
  get: publicProcedure
    .input(z.object({ token: z.string() }))
    .output(
      z.object({
        assetType: z.enum(ASSET_EXPORT_TYPES),
        name: z.string(),
        ownerName: z.string(),
        createdAt: z.date(),
        payload: z.unknown(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const [row] = await ctx.db
        .select({
          assetType: sharedAgentAssets.assetType,
          name: sharedAgentAssets.name,
          payload: sharedAgentAssets.payload,
          createdAt: sharedAgentAssets.createdAt,
          ownerName: users.name,
        })
        .from(sharedAgentAssets)
        .innerJoin(users, eq(users.id, sharedAgentAssets.userId))
        .where(eq(sharedAgentAssets.shareToken, input.token))
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Shared asset not found",
        });
      }
      return row;
    }),
});
