import { eq } from "drizzle-orm";

import type { DB, SaiyeDBTransaction } from "@saiye/db";
import { agentMessages } from "@saiye/db/schema";
import serverConfig from "@saiye/shared/config";

/**
 * D4-3 递归防护：自主咨询链的深度限制 + 环检测 + 链内预算熔断。
 *
 * 专家 Agent 自主发起子咨询（consult_agent）前必须通过本校验，否则
 * 自主 Agent 可相互咨询成环（A→B→A→…）无限烧钱。三种防线：
 * 1. 深度限制——子咨询深度超过全局上限即拒绝；
 * 2. 环检测——目标发布已在当前链的祖先中出现即拒绝；
 * 3. 预算熔断——链内已计费的自主层 credits + 本次价格超过授权预算即拒绝。
 */

export interface ConsultationGuardContext {
  /** 当前专家自己的发布 ID（排除自咨询 + 环检测种子） */
  selfPublicationId: string;
  /** 所有者为其批的自主咨询预算（credits；<=0 = 未授权，不暴露工具） */
  consultBudget: number;
  /** 当前正在执行的 A2A 消息 ID（null = 直接人工咨询，无消息链） */
  currentMessageId: string | null;
  /** 当前消息链深度（直接人工咨询 = 0） */
  currentDepth: number;
}

export type ConsultationGuardResult =
  | { ok: true }
  | { ok: false; reason: "depth" | "cycle" | "budget"; message: string };

export async function evaluateConsultationGuard(
  db: DB | SaiyeDBTransaction,
  ctx: ConsultationGuardContext,
  targetPublicationId: string,
  price: number,
): Promise<ConsultationGuardResult> {
  const maxDepth = serverConfig.consultation.agentConsultMaxDepth;
  const newDepth = ctx.currentDepth + 1;
  if (newDepth > maxDepth) {
    return {
      ok: false,
      reason: "depth",
      message: `自主咨询已超出最大链深度 ${maxDepth}`,
    };
  }

  // 沿 parentMessageId 链回溯：收集已访问发布（防环）与链内自主层
  // 已计费 credits（预算熔断）。防御性上限：即使数据异常也不死循环。
  const visited = new Set<string>([ctx.selfPublicationId]);
  let chainCredits = 0;
  let cursor: string | null = ctx.currentMessageId;
  let guard = 0;
  while (cursor && guard++ <= maxDepth + 1) {
    const [row] = await db
      .select({
        targetPublicationId: agentMessages.targetPublicationId,
        creditsCharged: agentMessages.creditsCharged,
        parentMessageId: agentMessages.parentMessageId,
        depth: agentMessages.depth,
      })
      .from(agentMessages)
      .where(eq(agentMessages.id, cursor))
      .limit(1);
    if (!row) {
      break;
    }
    visited.add(row.targetPublicationId);
    // 仅计自主发起层（depth >= 1）；根消息（人工发起）的计费不计入预算
    if (row.depth >= 1) {
      chainCredits += row.creditsCharged;
    }
    cursor = row.parentMessageId;
  }

  if (visited.has(targetPublicationId)) {
    return {
      ok: false,
      reason: "cycle",
      message: "检测到咨询环，已阻止重复咨询",
    };
  }

  if (chainCredits + price > ctx.consultBudget) {
    return {
      ok: false,
      reason: "budget",
      message: `超出自主咨询预算上限 ${ctx.consultBudget} credits`,
    };
  }

  return { ok: true };
}
