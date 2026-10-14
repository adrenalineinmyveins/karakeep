import { and, desc, eq, gt, or } from "drizzle-orm";
import { z } from "zod";

import { creditTransactions } from "@saiye/db/schema";
import serverConfig from "@saiye/shared/config";
import { CreditsService } from "@saiye/shared-server";

import { authedProcedure, router } from "../index";

const zTxType = z.enum([
  "subscription_grant",
  "consultation_charge",
  "consultation_payout",
  "refund",
  "admin_adjust",
]);

export const creditsRouter = router({
  // 当前余额 + 基本订阅信息
  getBalance: authedProcedure.query(async ({ ctx }) => {
    const balance = await CreditsService.getCreditsBalance(ctx.db, ctx.user.id);
    // 本月已消费 / 已收入
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const rows = await ctx.db
      .select({
        type: creditTransactions.type,
        delta: creditTransactions.delta,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, ctx.user.id),
          gt(creditTransactions.createdAt, monthStart),
          or(
            eq(creditTransactions.type, "consultation_charge"),
            eq(creditTransactions.type, "consultation_payout"),
          ),
        ),
      );

    const monthlySpent = rows
      .filter((r) => r.type === "consultation_charge")
      .reduce((s, r) => s + Math.abs(r.delta), 0);
    const monthlyEarned = rows
      .filter((r) => r.type === "consultation_payout")
      .reduce((s, r) => s + r.delta, 0);

    return {
      balance,
      monthlySpent,
      monthlyEarned,
      monthlyGrant: serverConfig.consultation.creditsPerMonthPaid,
    };
  }),

  // 分页流水（50 条 limit）
  getTransactions: authedProcedure
    .input(
      z.object({
        cursor: z.number().int().min(0).nullish(),
        limit: z.number().int().min(1).max(50).default(20),
        types: z.array(zTxType).nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const offset = input.cursor ?? 0;
      const limit = input.limit;
      const whereClauses: ReturnType<typeof and>[] = [
        eq(creditTransactions.userId, ctx.user.id),
      ];
      if (input.types?.length) {
        whereClauses.push(
          or(...input.types.map((t) => eq(creditTransactions.type, t))),
        );
      }

      const rows = await ctx.db
        .select()
        .from(creditTransactions)
        .where(and(...whereClauses))
        .orderBy(
          desc(creditTransactions.createdAt),
          desc(creditTransactions.id),
        )
        .limit(limit + 1)
        .offset(offset);

      const hasMore = rows.length > limit;
      return {
        transactions: hasMore ? rows.slice(0, limit) : rows,
        nextCursor: hasMore ? offset + limit : null,
      };
    }),
});
