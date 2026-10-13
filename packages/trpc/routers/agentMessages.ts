import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { DB } from "@saiye/db";
import {
  agentMessages,
  agentProfiles,
  agentPublications,
  agentSkills,
  consultationUsages,
} from "@saiye/db/schema";
import serverConfig from "@saiye/shared/config";
import { AgentMessageQueue } from "@saiye/shared-server";

import { authedProcedure, router } from "../index";
import { settleExpiredDelistings } from "./agentPublications";

const zMessageStateSchema = z.enum([
  "pending",
  "dispatched",
  "answered",
  "need_input",
  "expired",
  "failed",
]);

const zAgentMessageSchema = z.object({
  id: z.string(),
  requesterUserId: z.string(),
  requesterProfileId: z.string().nullable(),
  targetPublicationId: z.string(),
  skillId: z.string().nullable(),
  sessionId: z.string().nullable(),
  question: z.string(),
  answer: z.string().nullable(),
  state: zMessageStateSchema,
  note: z.string().nullable(),
  expiresAt: z.date(),
  createdAt: z.date().nullable(),
  modifiedAt: z.date().nullable(),
});

// offset 型 cursor（同 agentPublications.usages 的分页惯例）
const zListInputSchema = z.object({
  cursor: z.number().int().min(0).nullish(),
  limit: z.number().int().min(1).max(50).nullish(),
  states: z.array(zMessageStateSchema).max(6).nullish(),
});

const zListOutputSchema = z.object({
  messages: z.array(zAgentMessageSchema),
  nextCursor: z.number().nullable(),
});

async function listMessages(
  db: DB,
  where: ReturnType<typeof and>,
  input: z.infer<typeof zListInputSchema>,
): Promise<z.infer<typeof zListOutputSchema>> {
  const limit = input.limit ?? 20;
  const offset = input.cursor ?? 0;
  const rows = await db
    .select()
    .from(agentMessages)
    .where(
      input.states?.length
        ? and(where, inArray(agentMessages.state, input.states))
        : where,
    )
    .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = rows.length > limit;
  return {
    messages: hasMore ? rows.slice(0, limit) : rows,
    nextCursor: hasMore ? offset + limit : null,
  };
}

/**
 * A2A 咨询信箱：requester 向已发布的目标 Agent 发起异步咨询，
 * worker 经影子会话执行（沿用 owner 知识检索与计量记账）。
 * P0 仅支持"人确认后代发"；agent 自主发起的预算授权留待 P2。
 */
/**
 * 发起方三道护栏（防单用户扫场烧钱）。单目标限流只保护被咨询方，
 * 挡不住一个用户向全场 N 个 agent 各发 N-1 条。
 * - 每小时条数：跨所有目标（防轰炸）
 * - 当月条数：P0 0 价阶段的实际防线；发起即计（含 pending/expired/failed）
 * - 当月 credits 预算：定价启用后开启（config 未设置则跳过）。
 *   按 consultationUsages.consulteeUserId 汇总——该字段沿影子会话/
 *   咨询会话的 userId 记录，即咨询发起方。
 */
async function enforceRequesterLimits(db: DB, requesterUserId: string) {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [hourly] = await db
    .select({ n: count() })
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.requesterUserId, requesterUserId),
        gt(agentMessages.createdAt, hourAgo),
      ),
    );
  if (
    (hourly?.n ?? 0) >= serverConfig.consultation.agentMessageRequesterHourlyLimit
  ) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "You have sent too many consultations this hour, try later",
    });
  }

  const [monthly] = await db
    .select({ n: count() })
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.requesterUserId, requesterUserId),
        gt(agentMessages.createdAt, monthStart),
      ),
    );
  if ((monthly?.n ?? 0) >= serverConfig.consultation.agentMessageMonthlyLimit) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Monthly consultation limit reached",
    });
  }

  const budget = serverConfig.consultation.agentMessageMonthlyBudgetCredits;
  if (budget !== null && budget !== undefined) {
    const [spent] = await db
      .select({
        total: sql<number>`coalesce(sum(${consultationUsages.amount}), 0)`,
      })
      .from(consultationUsages)
      .where(
        and(
          eq(consultationUsages.consulteeUserId, requesterUserId),
          gt(consultationUsages.createdAt, monthStart),
        ),
      );
    if ((spent?.total ?? 0) >= budget) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Monthly consultation budget exhausted",
      });
    }
  }
}

export const agentMessagesAppRouter = router({
  // 发起咨询：校验目标可达性 + 每小时限流，落 pending 后入队
  send: authedProcedure
    .input(
      z.object({
        targetPublicationId: z.string(),
        question: z.string().min(1).max(8000),
        requesterProfileId: z.string().optional(),
        skillId: z.string().optional(),
      }),
    )
    .output(z.object({ message: zAgentMessageSchema }))
    .mutation(async ({ ctx, input }) => {
      await settleExpiredDelistings(ctx.db);
      const [target] = await ctx.db
        .select({
          publicationId: agentPublications.id,
          status: agentPublications.status,
          ownerUserId: agentPublications.userId,
          profileType: agentProfiles.type,
          profileId: agentProfiles.id,
        })
        .from(agentPublications)
        .innerJoin(
          agentProfiles,
          eq(agentProfiles.id, agentPublications.agentProfileId),
        )
        .where(eq(agentPublications.id, input.targetPublicationId))
        .limit(1);
      if (!target || target.status === "delisted") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Target agent is no longer available",
        });
      }
      // 与 chats.createSession 一致：不能咨询自己的发布
      if (target.ownerUserId === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot consult your own publication",
        });
      }
      if (target.profileType === "trae-cli") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This expert runs a local CLI runtime and does not support async consultation",
        });
      }

      // 限流：单目标每小时（EigenFlux friend_request_limits 模式）
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const [usage] = await ctx.db
        .select({ n: count() })
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.targetPublicationId, input.targetPublicationId),
            gt(agentMessages.createdAt, hourAgo),
          ),
        );
      if (
        (usage?.n ?? 0) >= serverConfig.consultation.agentMessageHourlyLimit
      ) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "This agent is receiving too many consultations, try later",
        });
      }

      // 发起方护栏：每小时/当月条数 + （可选）当月 credits 预算
      await enforceRequesterLimits(ctx.db, ctx.user.id);

      // 发起方个人档案（可空）：仅做归属校验
      if (input.requesterProfileId) {
        const [profile] = await ctx.db
          .select({ id: agentProfiles.id })
          .from(agentProfiles)
          .where(
            and(
              eq(agentProfiles.id, input.requesterProfileId),
              eq(agentProfiles.userId, ctx.user.id),
            ),
          )
          .limit(1);
        if (!profile) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Requester agent profile not found",
          });
        }
      }

      // 技能归属校验：必须挂在该发布绑定的档案下
      if (input.skillId) {
        const [skill] = await ctx.db
          .select({ id: agentSkills.id })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.id, input.skillId),
              eq(agentSkills.agentProfileId, target.profileId),
            ),
          )
          .limit(1);
        if (!skill) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Skill not found on this agent",
          });
        }
      }

      const [message] = await ctx.db
        .insert(agentMessages)
        .values({
          requesterUserId: ctx.user.id,
          requesterProfileId: input.requesterProfileId ?? null,
          targetPublicationId: input.targetPublicationId,
          skillId: input.skillId ?? null,
          question: input.question,
          state: "pending",
          expiresAt: new Date(
            Date.now() + serverConfig.consultation.agentMessageExpiryMs,
          ),
        })
        .returning();

      await AgentMessageQueue.enqueue({ messageId: message!.id });
      return { message: message! };
    }),

  // 发起方视角：我发出的咨询（states 过滤可作 fetchNew 轮询）
  listOutgoing: authedProcedure
    .input(zListInputSchema)
    .output(zListOutputSchema)
    .query(async ({ ctx, input }) =>
      listMessages(
        ctx.db,
        eq(agentMessages.requesterUserId, ctx.user.id),
        input,
      ),
    ),

  // 目标方视角：发给我发布的 Agent 的咨询（收件箱）
  listIncoming: authedProcedure
    .input(zListInputSchema)
    .output(zListOutputSchema)
    .query(async ({ ctx, input }) => {
      const myPublications = ctx.db
        .select({ id: agentPublications.id })
        .from(agentPublications)
        .where(eq(agentPublications.userId, ctx.user.id));
      return listMessages(
        ctx.db,
        inArray(agentMessages.targetPublicationId, myPublications),
        input,
      );
    }),

  // 发起方重试失败/过期消息（仅这两种状态，回到 pending 重新入队）
  retry: authedProcedure
    .input(z.object({ id: z.string() }))
    .output(z.object({ message: zAgentMessageSchema }))
    .mutation(async ({ ctx, input }) => {
      const [message] = await ctx.db
        .select()
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.id, input.id),
            eq(agentMessages.requesterUserId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!message) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Message not found",
        });
      }
      if (message.state !== "failed" && message.state !== "expired") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only failed or expired messages can be retried",
        });
      }
      if (message.expiresAt.getTime() < Date.now()) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Message has expired; send a new one instead",
        });
      }
      const [updated] = await ctx.db
        .update(agentMessages)
        .set({ state: "pending", note: null, modifiedAt: new Date() })
        .where(eq(agentMessages.id, input.id))
        .returning();
      await AgentMessageQueue.enqueue({ messageId: input.id });
      return { message: updated! };
    }),
});
