import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { widgetVersions, widgets } from "@saiye/db/schema";
import {
  lintWidgetCode,
  zWidgetManifestSchema,
  zWidgetStatusSchema,
} from "@saiye/shared/types/widgets";
import type { ZWidgetManifest } from "@saiye/shared/types/widgets";
import {
  buildAssetExportEnvelope,
  zAssetExportEnvelopeSchema,
} from "@saiye/shared/types/assetExport";

import type { AuthedContext } from "../index";
import { authedProcedure, router } from "../index";

/**
 * Widget（chat 用户定制组件）路由。
 *
 * 版本规则（append-only）：
 * - save：建 widget(draft) + 版本行 v1
 * - update：currentVersion+1，插入新版本行
 * - rollback：把目标版本内容复制为新版本（v=max+1），历史永不丢失
 *
 * D9 权限收紧：update/rollback 后的 manifest.permissions 出现新增能力（⊄ 当前）时，
 * 服务端强制 status 回 draft，必须重新经用户安装确认。
 */

function parseManifest(manifest: unknown): ZWidgetManifest {
  const parsed = zWidgetManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid widget manifest: ${parsed.error.message}`,
    });
  }
  return parsed.data;
}

function assertCodeAllowed(code: string) {
  const violations = lintWidgetCode(code);
  if (violations.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Widget code lint failed: ${violations.join("; ")}`,
    });
  }
}

/** D9：newPermissions 相对 oldPermissions 出现新增能力则为扩权 */
function isPermissionExpansion(
  oldPermissions: string[],
  newPermissions: string[],
): boolean {
  return newPermissions.some((p) => !oldPermissions.includes(p));
}

async function getOwnedWidget(
  db: AuthedContext["db"],
  widgetId: string,
  userId: string,
) {
  const [found] = await db
    .select()
    .from(widgets)
    .where(and(eq(widgets.id, widgetId), eq(widgets.userId, userId)))
    .limit(1);
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Widget not found" });
  }
  return found;
}

/** 建 widget(draft) + 版本行 v1（save 与 C1 importAsset / C2 fork 共用） */
export async function insertDraftWidget(
  db: AuthedContext["db"],
  userId: string,
  input: {
    name: string;
    description?: string | null;
    manifest: unknown;
    code: string;
  },
) {
  assertCodeAllowed(input.code);
  const manifest = parseManifest(input.manifest);

  const [created] = await db
    .insert(widgets)
    .values({
      userId,
      name: input.name,
      description: input.description,
      manifest,
      code: input.code,
      status: "draft",
      currentVersion: 1,
    })
    .returning({ id: widgets.id });

  await db.insert(widgetVersions).values({
    widgetId: created.id,
    version: 1,
    code: input.code,
    manifest,
  });

  return { id: created.id, version: 1 };
}

export const widgetsAppRouter = router({
  // 创建组件（draft）+ 版本行 v1
  save: authedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        manifest: zWidgetManifestSchema,
        code: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return await insertDraftWidget(ctx.db, ctx.user.id, input);
    }),

  // 更新组件：可变字段任意组合；code/manifest 变更时产生新版本
  update: authedProcedure
    .input(
      z.object({
        widgetId: z.string(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        manifest: zWidgetManifestSchema.optional(),
        code: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const found = await getOwnedWidget(ctx.db, input.widgetId, ctx.user.id);

      const nextCode = input.code ?? found.code;
      const nextManifest = parseManifest(
        input.manifest ?? found.manifest ?? undefined,
      );
      if (input.code !== undefined) {
        assertCodeAllowed(input.code);
      }

      const hasNewVersion =
        input.code !== undefined || input.manifest !== undefined;
      const nextVersion = hasNewVersion
        ? found.currentVersion + 1
        : found.currentVersion;

      // D9：扩权 → 强制回 draft 重新安装
      const oldManifest = parseManifest(found.manifest ?? undefined);
      const expanded = isPermissionExpansion(
        oldManifest.permissions,
        nextManifest.permissions,
      );

      const [updated] = await ctx.db
        .update(widgets)
        .set({
          name: input.name ?? found.name,
          description: input.description ?? found.description,
          manifest: nextManifest,
          code: nextCode,
          currentVersion: nextVersion,
          ...(expanded ? { status: "draft" as const } : {}),
        })
        .where(
          and(eq(widgets.id, input.widgetId), eq(widgets.userId, ctx.user.id)),
        )
        .returning();

      if (hasNewVersion) {
        await ctx.db.insert(widgetVersions).values({
          widgetId: input.widgetId,
          version: nextVersion,
          code: nextCode,
          manifest: nextManifest,
        });
      }

      return {
        id: updated.id,
        version: nextVersion,
        status: updated.status,
        reInstallRequired: expanded,
      };
    }),

  // 摘要列表（不含 code）
  list: authedProcedure.query(async ({ ctx }) => {
    return await ctx.db
      .select({
        id: widgets.id,
        name: widgets.name,
        description: widgets.description,
        manifest: widgets.manifest,
        status: widgets.status,
        currentVersion: widgets.currentVersion,
        createdAt: widgets.createdAt,
        modifiedAt: widgets.modifiedAt,
      })
      .from(widgets)
      .where(eq(widgets.userId, ctx.user.id))
      .orderBy(desc(widgets.modifiedAt));
  }),

  // 全量（预览卡用）
  get: authedProcedure
    .input(z.object({ widgetId: z.string() }))
    .query(async ({ ctx, input }) => {
      return await getOwnedWidget(ctx.db, input.widgetId, ctx.user.id);
    }),

  // 安装 / 卸载
  setStatus: authedProcedure
    .input(
      z.object({
        widgetId: z.string(),
        status: zWidgetStatusSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(widgets)
        .set({ status: input.status })
        .where(
          and(eq(widgets.id, input.widgetId), eq(widgets.userId, ctx.user.id)),
        )
        .returning({ id: widgets.id, status: widgets.status });
      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Widget not found" });
      }
      return updated;
    }),

  // 删除（级联删版本）
  delete: authedProcedure
    .input(z.object({ widgetId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await ctx.db
        .delete(widgets)
        .where(
          and(eq(widgets.id, input.widgetId), eq(widgets.userId, ctx.user.id)),
        )
        .returning({ id: widgets.id });
      if (deleted.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Widget not found" });
      }
      return { success: true };
    }),

  // 版本摘要（chat 回滚用，不含 code）
  listVersions: authedProcedure
    .input(z.object({ widgetId: z.string() }))
    .query(async ({ ctx, input }) => {
      await getOwnedWidget(ctx.db, input.widgetId, ctx.user.id);
      return await ctx.db
        .select({
          version: widgetVersions.version,
          createdAt: widgetVersions.createdAt,
        })
        .from(widgetVersions)
        .where(eq(widgetVersions.widgetId, input.widgetId))
        .orderBy(desc(widgetVersions.version));
    }),

  // 回滚：把目标版本内容复制为新版本（append-only，历史永不丢失）
  rollback: authedProcedure
    .input(
      z.object({
        widgetId: z.string(),
        version: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const found = await getOwnedWidget(ctx.db, input.widgetId, ctx.user.id);

      const versions = await ctx.db
        .select()
        .from(widgetVersions)
        .where(eq(widgetVersions.widgetId, input.widgetId))
        .orderBy(desc(widgetVersions.version));

      const target =
        input.version !== undefined
          ? versions.find((v) => v.version === input.version)
          : versions.find((v) => v.version < found.currentVersion); // 默认上一版
      if (!target) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Rollback target version not found",
        });
      }

      const nextVersion = versions[0].version + 1;

      // D9：回滚目标权限 ⊃ 当前已授权权限 → 强制回 draft
      const currentManifest = parseManifest(found.manifest ?? undefined);
      const targetManifest = parseManifest(target.manifest ?? undefined);
      const expanded = isPermissionExpansion(
        currentManifest.permissions,
        targetManifest.permissions,
      );

      await ctx.db.insert(widgetVersions).values({
        widgetId: input.widgetId,
        version: nextVersion,
        code: target.code,
        manifest: target.manifest,
      });

      const [updated] = await ctx.db
        .update(widgets)
        .set({
          code: target.code,
          manifest: target.manifest,
          currentVersion: nextVersion,
          ...(expanded ? { status: "draft" as const } : {}),
        })
        .where(
          and(eq(widgets.id, input.widgetId), eq(widgets.userId, ctx.user.id)),
        )
        .returning({ status: widgets.status });

      return {
        version: nextVersion,
        rolledBackFrom: target.version,
        status: updated.status,
        reInstallRequired: expanded,
      };
    }),

  // C1 导出：name/description/manifest/code 全量（无敏感字段）
  exportAsset: authedProcedure
    .input(z.object({ widgetId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const found = await getOwnedWidget(ctx.db, input.widgetId, ctx.user.id);
      return buildAssetExportEnvelope("widget", {
        name: found.name,
        description: found.description,
        manifest: found.manifest,
        code: found.code,
      });
    }),

  // C1 导入：走与 save 相同的 lint/manifest 校验，落地为 draft 需手动启用
  importAsset: authedProcedure
    .input(z.object({ envelope: zAssetExportEnvelopeSchema }))
    .mutation(async ({ ctx, input }) => {
      if (input.envelope.assetType !== "widget") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This file does not contain a widget",
        });
      }
      const data = z
        .object({
          name: z.string().min(1).max(100),
          description: z.string().max(500).nullable(),
          manifest: zWidgetManifestSchema,
          code: z.string().min(1),
        })
        .safeParse(input.envelope.data);
      if (!data.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid widget data: ${data.error.message}`,
        });
      }
      return await insertDraftWidget(ctx.db, ctx.user.id, data.data);
    }),
});
