import { and, eq, sql } from "drizzle-orm";

import type { DB, SaiyeDBTransaction } from "@saiye/db";
import { creditTransactions, users } from "@saiye/db/schema";

export class InsufficientCreditsError extends Error {
  constructor(public readonly balance: number, public readonly required: number) {
    super(`Credits 不足：当前 ${balance}，需要 ${required}`);
    this.name = "InsufficientCreditsError";
  }
}

export type CreditTxType =
  | "subscription_grant"
  | "consultation_charge"
  | "consultation_payout"
  | "refund"
  | "admin_adjust";

export type DBOrTrx = DB | SaiyeDBTransaction;

export class CreditsService {
  /**
   * 原子扣减 credits：WHERE creditsBalance >= amount 防穿底。
   * 返回 null 表示余额不足；否则返回扣减后的新余额。
   */
  static async chargeCredits(
    db: DBOrTrx,
    userId: string,
    amount: number,
    opts?: { referenceType?: string; referenceId?: string },
  ): Promise<number | null> {
    if (amount <= 0) return null;

    const updateResult = await db
      .update(users)
      .set({ creditsBalance: sql`${users.creditsBalance} - ${amount}` })
      .where(
        and(
          eq(users.id, userId),
          sql`${users.creditsBalance} >= ${amount}`,
        ),
      );

    if (updateResult.rowCount === 0) {
      return null;
    }

    // 取新余额写 ledger
    const [row] = await db
      .select({ balance: users.creditsBalance })
      .from(users)
      .where(eq(users.id, userId));
    const newBalance = row?.balance ?? 0;

    await db.insert(creditTransactions).values({
      userId,
      delta: -amount,
      type: "consultation_charge",
      referenceType: opts?.referenceType,
      referenceId: opts?.referenceId,
      balanceAfter: newBalance,
    });

    return newBalance;
  }

  /**
   * 增加 credits（赠送 / 收益入账 / 退款 / 管理员调整）。
   */
  static async creditCredits(
    db: DBOrTrx,
    userId: string,
    amount: number,
    type: CreditTxType,
    opts?: { referenceType?: string; referenceId?: string },
  ): Promise<number> {
    if (amount <= 0) throw new Error("creditCredits: amount 必须为正数");

    await db
      .update(users)
      .set({ creditsBalance: sql`${users.creditsBalance} + ${amount}` })
      .where(eq(users.id, userId));

    const [row] = await db
      .select({ balance: users.creditsBalance })
      .from(users)
      .where(eq(users.id, userId));
    const newBalance = row?.balance ?? 0;

    await db.insert(creditTransactions).values({
      userId,
      delta: amount,
      type,
      referenceType: opts?.referenceType,
      referenceId: opts?.referenceId,
      balanceAfter: newBalance,
    });

    return newBalance;
  }

  static async getCreditsBalance(
    db: DBOrTrx,
    userId: string,
  ): Promise<number> {
    const [row] = await db
      .select({ balance: users.creditsBalance })
      .from(users)
      .where(eq(users.id, userId));
    return row?.balance ?? 0;
  }

  /**
   * 对账：比较 users.creditsBalance 与 ledger SUM(delta)。
   * 不一致时返回 delta（负数表示 users.creditsBalance 多记了）。
   */
  static async reconcileBalance(
    db: DBOrTrx,
    userId: string,
  ): Promise<{ usersValue: number; ledgerValue: number; diff: number }> {
    const [u] = await db
      .select({ balance: users.creditsBalance })
      .from(users)
      .where(eq(users.id, userId));
    const [l] = await db
      .select({ total: sql<number>`coalesce(sum(${creditTransactions.delta}), 0)` })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId));

    const usersValue = u?.balance ?? 0;
    const ledgerValue = Number(l?.total ?? 0);
    return { usersValue, ledgerValue, diff: usersValue - ledgerValue };
  }
}
