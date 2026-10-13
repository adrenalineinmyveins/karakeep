import { TRPCError } from "@trpc/server";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { DB } from "@saiye/db";
import {
  agentProfiles,
  agentPublications,
  chatSessions,
  consultationSettlements,
  consultationUsages,
  users,
} from "@saiye/db/schema";
import serverConfig from "@saiye/shared/config";
import logger from "@saiye/shared/logger";

import { authedProcedure, router } from "../index";
import { AGENT_PROFILE_TYPES } from "@saiye/shared/types/agentProfiles";

// F1 联邦化：运营参数挪到 serverConfig（env 可覆盖）；
// 保留导出名，取值时机为模块加载（与 env 单例解析一致）。
// 下架缓冲期：进入 delisting 后已购会话继续服务的最长时间窗。
export const DELISTING_GRACE_PERIOD_MS =
  serverConfig.consultation.delistingGracePeriodMs;

// 会话计费封顶（credits）全局默认：单会话累计达到后停止服务，
// 防失控消费。发布可通过 billingCapPerSession 单独覆盖。
export const SESSION_BILLING_CAP_CREDITS =
  serverConfig.consultation.sessionBillingCapCredits;

const zPublicationStatusSchema = z.enum(["published", "delisting", "delisted"]);

const zPublicationSchema = z.object({
  id: z.string(),
  agentProfileId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  pricePerCall: z.number(),
  // F2 per-publication 封顶；null = 跟随全局默认
  billingCapPerSession: z.number().nullable(),
  status: zPublicationStatusSchema,
  delistingAt: z.date().nullable(),
  delistedAt: z.date().nullable(),
  createdAt: z.date().nullable(),
  modifiedAt: z.date().nullable(),
});

// 咨询者可见卡片：不含 agentProfile 私有配置，仅带所有者显示名
const zPublicationCardSchema = zPublicationSchema.and(
  z.object({
    ownerName: z.string(),
    // delisting 状态下的缓冲期截止时间（published 为 null）
    graceEndsAt: z.date().nullable(),
    // 目标 Agent 运行时（hosted = 个人 Agent，其余 = 联邦外部专家）
    runtime: z.enum(AGENT_PROFILE_TYPES),
    // Agent Card 专长摘要（D2 喂养生成；null = 未生成）
    autoExpertise: z.array(z.string()).nullable(),
    avatarAssetId: z.string().nullable(),
    // 是否当前查看者自己的发布（前端据此隐藏咨询入口）
    isOwn: z.boolean(),
  }),
);

// F4 结算单（一批未结算 usage 的汇总快照）
const zSettlementSchema = z.object({
  id: z.string(),
  publicationId: z.string(),
  userId: z.string(),
  amount: z.number(),
  usageCount: z.number(),
  createdAt: z.date().nullable(),
});

const zPublishInputSchema = z.object({
  agentProfileId: z.string(),
  title: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  pricePerCall: z.number().int().min(0).max(100_000).optional(),
  // F2 会话计费封顶（credits）；不传/传 null = 跟随全局默认
  billingCapPerSession: z.number().int().min(1).max(10_000_000).nullish(),
});

const zUpdateInputSchema = zPublishInputSchema
  .omit({ agentProfileId: true })
  .partial()
  .and(z.object({ id: z.string() }));

/** 惰性状态机：缓冲期到期的 delisting 行升级为 delisted（读路径触发，无 cron） */
export async function settleExpiredDelistings(db: DB) {
  const cutoff = new Date(Date.now() - DELISTING_GRACE_PERIOD_MS);
  await db
    .update(agentPublications)
    .set({ status: "delisted", delistedAt: new Date() })
    .where(
      and(
        eq(agentPublications.status, "delisting"),
        isNotNull(agentPublications.delistingAt),
        lte(agentPublications.delistingAt, cutoff),
      ),
    );
}

/** 会话累计已计费（credits） */
export async function getSessionChargedCredits(
  db: DB,
  sessionId: string,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${consultationUsages.amount}), 0)`,
    })
    .from(consultationUsages)
    .where(eq(consultationUsages.sessionId, sessionId));
  return row?.total ?? 0;
}

/** F2 生效封顶（credits）：发布单独配置优先，null 回退全局默认 */
export async function getSessionBillingCap(
  db: DB,
  publicationId: string,
): Promise<number> {
  const [row] = await db
    .select({ cap: agentPublications.billingCapPerSession })
    .from(agentPublications)
    .where(eq(agentPublications.id, publicationId))
    .limit(1);
  return row?.cap ?? SESSION_BILLING_CAP_CREDITS;
}

/**
 * D6 计量记账：咨询会话每条成功回复记一笔，amount 取发布当前单价快照
 * （调价不影响已记条目）。P0 只记账不结算；记账是增强而非依赖，
 * 失败静默（logger.warn），不影响回复本身。
 * P2：skillId 记录该轮点选的技能（使用统计）。
 */
export async function recordConsultationUsage(
  db: DB,
  session: Pick<
    typeof chatSessions.$inferSelect,
    "id" | "userId" | "publicationId"
  >,
  skillId?: string | null,
): Promise<void> {
  try {
    if (!session.publicationId) return;
    const [pub] = await db
      .select({ pricePerCall: agentPublications.pricePerCall })
      .from(agentPublications)
      .where(eq(agentPublications.id, session.publicationId))
      .limit(1);
    if (!pub) return;
    await db.insert(consultationUsages).values({
      publicationId: session.publicationId,
      consulteeUserId: session.userId,
      sessionId: session.id,
      amount: pub.pricePerCall,
      ...(skillId ? { skillId } : {}),
    });
  } catch (e) {
    logger.warn(
      `[consultationUsage] 记账失败（静默跳过）: session=${session.id}, ${String(e)}`,
    );
  }
}

async function fetchOwnedPublication(db: DB, userId: string, id: string) {
  const row = await db.query.agentPublications.findFirst({
    where: and(
      eq(agentPublications.id, id),
      eq(agentPublications.userId, userId),
    ),
  });
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Publication not found",
    });
  }
  return row;
}

/** 转咨询者卡片（带所有者显示名、缓冲期截止时间与运行时） */
async function toCard(
  db: DB,
  row: typeof agentPublications.$inferSelect,
  runtime: (typeof AGENT_PROFILE_TYPES)[number],
  viewerId: string,
) {
  const owner = await db.query.users.findFirst({
    where: eq(users.id, row.userId),
    columns: { name: true },
  });
  return {
    ...row,
    ownerName: owner?.name ?? "",
    graceEndsAt:
      row.status === "delisting" && row.delistingAt
        ? new Date(row.delistingAt.getTime() + DELISTING_GRACE_PERIOD_MS)
        : null,
    runtime,
    isOwn: row.userId === viewerId,
  };
}

export const agentPublicationsAppRouter = router({
  // 所有者：发布（或复活已 delisted 的发布）
  publish: authedProcedure
    .input(zPublishInputSchema)
    .output(z.object({ publication: zPublicationSchema }))
    .mutation(async ({ ctx, input }) => {
      const profile = await ctx.db.query.agentProfiles.findFirst({
        where: and(
          eq(agentProfiles.id, input.agentProfileId),
          eq(agentProfiles.userId, ctx.user.id),
        ),
        columns: { id: true, type: true, apiKey: true },
      });
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Agent profile not found",
        });
      }
      if (profile.type === "openai-compatible" && !profile.apiKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This profile has no API key configured and cannot be published",
        });
      }

      const values = {
        title: input.title,
        description: input.description ?? null,
        tags: input.tags ?? [],
        pricePerCall: input.pricePerCall ?? 0,
        billingCapPerSession: input.billingCapPerSession ?? null,
      };

      const existing = await ctx.db.query.agentPublications.findFirst({
        where: eq(agentPublications.agentProfileId, input.agentProfileId),
      });
      if (existing) {
        if (existing.status !== "delisted") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This agent profile is already published",
          });
        }
        // delisted → 复活（复用同一行，保持唯一约束）
        const [row] = await ctx.db
          .update(agentPublications)
          .set({
            ...values,
            status: "published",
            delistingAt: null,
            delistedAt: null,
            modifiedAt: new Date(),
          })
          .where(eq(agentPublications.id, existing.id))
          .returning();
        return { publication: row };
      }

      const [row] = await ctx.db
        .insert(agentPublications)
        .values({
          userId: ctx.user.id,
          agentProfileId: input.agentProfileId,
          ...values,
        })
        .returning();
      return { publication: row };
    }),

  // 所有者：更新元数据/定价（仅 published 状态）
  update: authedProcedure
    .input(zUpdateInputSchema)
    .output(z.object({ publication: zPublicationSchema }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...rest } = input;
      const row = await fetchOwnedPublication(ctx.db, ctx.user.id, id);
      if (row.status !== "published") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only published publications can be updated",
        });
      }
      const [updated] = await ctx.db
        .update(agentPublications)
        .set({ ...rest, modifiedAt: new Date() })
        .where(eq(agentPublications.id, id))
        .returning();
      return { publication: updated };
    }),

  // 所有者：申请下架 → 进入缓冲期
  delist: authedProcedure
    .input(z.object({ id: z.string() }))
    .output(z.object({ publication: zPublicationSchema }))
    .mutation(async ({ ctx, input }) => {
      const row = await fetchOwnedPublication(ctx.db, ctx.user.id, input.id);
      if (row.status !== "published") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only published publications can be delisted",
        });
      }
      const [updated] = await ctx.db
        .update(agentPublications)
        .set({
          status: "delisting",
          delistingAt: new Date(),
          modifiedAt: new Date(),
        })
        .where(eq(agentPublications.id, input.id))
        .returning();
      return { publication: updated };
    }),

  // 所有者：缓冲期内恢复上架
  restore: authedProcedure
    .input(z.object({ id: z.string() }))
    .output(z.object({ publication: zPublicationSchema }))
    .mutation(async ({ ctx, input }) => {
      await settleExpiredDelistings(ctx.db);
      const row = await fetchOwnedPublication(ctx.db, ctx.user.id, input.id);
      if (row.status !== "delisting") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only delisting publications can be restored",
        });
      }
      const [updated] = await ctx.db
        .update(agentPublications)
        .set({ status: "published", delistingAt: null, modifiedAt: new Date() })
        .where(eq(agentPublications.id, input.id))
        .returning();
      return { publication: updated };
    }),

  // 所有者：自己的全部发布（含各状态）
  list: authedProcedure
    .output(z.object({ publications: z.array(zPublicationSchema) }))
    .query(async ({ ctx }) => {
      await settleExpiredDelistings(ctx.db);
      const rows = await ctx.db.query.agentPublications.findMany({
        where: eq(agentPublications.userId, ctx.user.id),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });
      return { publications: rows };
    }),

  // 咨询者：发现可咨询的专家（published + delisting 均可见，delisting 标记"下架中"）。
  // 可选 query（标题/描述模糊）/ tag（标签精确）过滤。
  discover: authedProcedure
    .input(
      z
        .object({
          query: z.string().min(1).max(120).optional(),
          tag: z.string().min(1).max(40).optional(),
        })
        .nullish(),
    )
    .output(z.object({ publications: z.array(zPublicationCardSchema) }))
    .query(async ({ ctx, input }) => {
      await settleExpiredDelistings(ctx.db);
      const conditions = [
        inArray(agentPublications.status, ["published", "delisting"]),
      ];
      if (input?.tag) {
        // tags 为 jsonb 数组；@> 检查包含该标签
        conditions.push(
          sql`${agentPublications.tags} @> ${JSON.stringify([input.tag])}::jsonb`,
        );
      }
      if (input?.query) {
        const pattern = `%${input.query}%`;
        conditions.push(
          or(
            ilike(agentPublications.title, pattern),
            ilike(agentPublications.description, pattern),
          )!,
        );
      }
      const rows = await ctx.db
        .select({ pub: agentPublications, runtime: agentProfiles.type })
        .from(agentPublications)
        .innerJoin(
          agentProfiles,
          eq(agentProfiles.id, agentPublications.agentProfileId),
        )
        .where(and(...conditions))
        .orderBy(desc(agentPublications.createdAt))
        .limit(100);
      return {
        publications: await Promise.all(
          rows.map((r) => toCard(ctx.db, r.pub, r.runtime, ctx.user.id)),
        ),
      };
    }),

  // 所有者：查某发布的咨询计量（F3；分页 + 汇总，offset 型 cursor）。
  // consulteeUserId 只暴露 id 不暴露姓名/邮箱（隐私最小化）。
  usages: authedProcedure
    .input(
      z.object({
        id: z.string(),
        cursor: z.number().int().min(0).nullish(),
        limit: z.number().int().min(1).max(100).nullish(),
      }),
    )
    .output(
      z.object({
        usages: z.array(
          z.object({
            id: z.string(),
            sessionId: z.string(),
            consulteeUserId: z.string(),
            amount: z.number(),
            settlementId: z.string().nullable(),
            createdAt: z.date().nullable(),
          }),
        ),
        nextCursor: z.number().nullable(),
        totalCredits: z.number(),
        totalCount: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await fetchOwnedPublication(ctx.db, ctx.user.id, input.id);
      const limit = input.limit ?? 50;
      const offset = input.cursor ?? 0;
      const where = eq(consultationUsages.publicationId, input.id);
      const [items, [agg]] = await Promise.all([
        ctx.db
          .select({
            id: consultationUsages.id,
            sessionId: consultationUsages.sessionId,
            consulteeUserId: consultationUsages.consulteeUserId,
            amount: consultationUsages.amount,
            settlementId: consultationUsages.settlementId,
            createdAt: consultationUsages.createdAt,
          })
          .from(consultationUsages)
          .where(where)
          .orderBy(
            desc(consultationUsages.createdAt),
            desc(consultationUsages.id),
          )
          .limit(limit + 1)
          .offset(offset),
        ctx.db
          .select({
            totalCredits: sql<number>`coalesce(sum(${consultationUsages.amount}), 0)`,
            totalCount: sql<number>`count(*)`,
          })
          .from(consultationUsages)
          .where(where),
      ]);
      const hasMore = items.length > limit;
      return {
        usages: hasMore ? items.slice(0, limit) : items,
        nextCursor: hasMore ? offset + limit : null,
        totalCredits: agg?.totalCredits ?? 0,
        totalCount: agg?.totalCount ?? 0,
      };
    }),

  // 所有者：把该发布全部未结算 usage 打包成结算单（F4）。
  // P1 无支付通道，结算 = 汇总快照 + usage 标记；P2 在此接入真实支付。
  // 事务保证打包原子性（better-sqlite3 单连接事务天然串行，无并发竞态）。
  settle: authedProcedure
    .input(z.object({ id: z.string() }))
    .output(z.object({ settlement: zSettlementSchema }))
    .mutation(async ({ ctx, input }) => {
      const pub = await fetchOwnedPublication(ctx.db, ctx.user.id, input.id);
      const unsettledWhere = and(
        eq(consultationUsages.publicationId, input.id),
        isNull(consultationUsages.settlementId),
      );
      return ctx.db.transaction(async (tx) => {
        const [agg] = await tx
          .select({
            total: sql<number>`coalesce(sum(${consultationUsages.amount}), 0)`,
            count: sql<number>`count(*)`,
          })
          .from(consultationUsages)
          .where(unsettledWhere);
        if (!agg || agg.count === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "No unsettled usage to settle",
          });
        }
        const [settlement] = await tx
          .insert(consultationSettlements)
          .values({
            publicationId: input.id,
            userId: pub.userId,
            amount: agg.total,
            usageCount: agg.count,
          })
          .returning();
        await tx
          .update(consultationUsages)
          .set({ settlementId: settlement!.id })
          .where(unsettledWhere);
        return { settlement: settlement! };
      });
    }),

  // 所有者：查某发布的结算单列表（F4；分页同 usages）
  settlements: authedProcedure
    .input(
      z.object({
        id: z.string(),
        cursor: z.number().int().min(0).nullish(),
        limit: z.number().int().min(1).max(100).nullish(),
      }),
    )
    .output(
      z.object({
        settlements: z.array(zSettlementSchema),
        nextCursor: z.number().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await fetchOwnedPublication(ctx.db, ctx.user.id, input.id);
      const limit = input.limit ?? 50;
      const offset = input.cursor ?? 0;
      const items = await ctx.db
        .select()
        .from(consultationSettlements)
        .where(eq(consultationSettlements.publicationId, input.id))
        .orderBy(
          desc(consultationSettlements.createdAt),
          desc(consultationSettlements.id),
        )
        .limit(limit + 1)
        .offset(offset);
      const hasMore = items.length > limit;
      return {
        settlements: hasMore ? items.slice(0, limit) : items,
        nextCursor: hasMore ? offset + limit : null,
      };
    }),

  // 咨询者：查看单个发布卡片（delisted 不可见）
  get: authedProcedure
    .input(z.object({ id: z.string() }))
    .output(z.object({ publication: zPublicationCardSchema }))
    .query(async ({ ctx, input }) => {
      await settleExpiredDelistings(ctx.db);
      const [row] = await ctx.db
        .select({ pub: agentPublications, runtime: agentProfiles.type })
        .from(agentPublications)
        .innerJoin(
          agentProfiles,
          eq(agentProfiles.id, agentPublications.agentProfileId),
        )
        .where(eq(agentPublications.id, input.id))
        .limit(1);
      if (!row || row.pub.status === "delisted") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Publication not found",
        });
      }
      return {
        publication: await toCard(ctx.db, row.pub, row.runtime, ctx.user.id),
      };
    }),
});
