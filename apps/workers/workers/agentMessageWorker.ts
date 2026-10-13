import { and, eq, sql } from "drizzle-orm";
import { workerStatsCounter } from "metrics";
import { buildImpersonatingTRPCClient } from "trpc";
import { withWorkerEventLog, withWorkerTracing } from "workerTracing";

import { db } from "@saiye/db";
import {
  agentMessages,
  agentProfiles,
  agentPublications,
  chatSessions,
  creditTransactions,
} from "@saiye/db/schema";
import {
  addLogFields,
  AgentMessageQueue,
  CreditsService,
  zAgentMessageRequestSchema,
} from "@saiye/shared-server";
import logger from "@saiye/shared/logger";
import serverConfig from "@saiye/shared/config";
import { DequeuedJob, getQueueClient } from "@saiye/shared/queueing";

import type { ZAgentMessageRequest } from "@saiye/shared-server";

/**
 * A2A 咨询消息执行器：状态机自管（队列层不重试，防止重复执行/重复计费）。
 * pending → dispatched → answered | failed | expired
 * 执行复用影子会话 + chats.sendMessageSync：知识检索按发布所有者、
 * 计量记账、计费封顶全部沿用同步咨询链路。
 */
export class AgentMessageWorker {
  static async build() {
    logger.info("Starting agent message worker ...");
    const worker = (await getQueueClient())!.createRunner<ZAgentMessageRequest>(
      AgentMessageQueue,
      {
        run: withWorkerTracing(
          "agentMessageWorker.run",
          withWorkerEventLog("agentMessageWorker.run", runAgentMessage),
        ),
        onComplete: (job) => {
          workerStatsCounter.labels("agentMessage", "completed").inc();
          const jobId = job.id;
          logger.info(`[agentMessage][${jobId}] Completed successfully`);
          return Promise.resolve();
        },
        onError: (job) => {
          workerStatsCounter.labels("agentMessage", "failed").inc();
          const jobId = job.id;
          logger.error(
            `[agentMessage][${jobId}] agent message job failed: ${job.error}\n${job.error.stack}`,
          );
          return Promise.resolve();
        },
      },
      {
        concurrency: 2,
        pollIntervalMs: 1000,
        // sendMessageSync 内部受 orchestrator 120s 端到端时限约束，留缓冲
        timeoutSecs: 180,
        validator: zAgentMessageRequestSchema,
      },
    );

    return worker;
  }
}

/** 影子会话标题：与 chats.sanitizeTitle 同规则（截断，不做 LLM 清洗） */
function shadowTitle(question: string): string {
  return question.replace(/\s+/g, " ").trim().slice(0, 50) || "A2A 咨询";
}

async function runAgentMessage(job: DequeuedJob<ZAgentMessageRequest>) {
  const jobId = job.id;
  const { messageId } = job.data;
  addLogFields<"agentMessageWorker.run">({
    "agent_message.id": messageId,
  });

  const [message] = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.id, messageId))
    .limit(1);
  if (!message) {
    logger.info(
      `[agentMessage][${jobId}] message ${messageId} not found, skipping`,
    );
    return;
  }
  // 幂等：仅执行 pending（重试由状态机显式触发，队列不重投）
  if (message.state !== "pending") {
    logger.info(
      `[agentMessage][${jobId}] message ${messageId} state=${message.state}, skipping`,
    );
    return;
  }
  // 惰性过期（EigenFlux delisted 惰性结算同模式）
  if (message.expiresAt.getTime() < Date.now()) {
    await db
      .update(agentMessages)
      .set({ state: "expired", modifiedAt: new Date() })
      .where(eq(agentMessages.id, messageId));
    // Refund：过期未执行 → 扣的 credits 退回
    if (message.creditsCharged > 0) {
      await safeRefund(db, message);
    }
    logger.info(`[agentMessage][${jobId}] message expired before dispatch`);
    return;
  }

  // 目标发布 + 档案校验（trae-cli 型无异步可达性，P0 不支持）
  const [target] = await db
    .select({
      publicationId: agentPublications.id,
      publicationUserId: agentPublications.userId,
      publicationStatus: agentPublications.status,
      profileId: agentProfiles.id,
      profileType: agentProfiles.type,
    })
    .from(agentPublications)
    .innerJoin(
      agentProfiles,
      eq(agentProfiles.id, agentPublications.agentProfileId),
    )
    .where(eq(agentPublications.id, message.targetPublicationId))
    .limit(1);
  if (!target || target.publicationStatus === "delisted") {
    await failMessage(db, messageId, "Target agent is no longer available");
    if (message.creditsCharged > 0) await safeRefund(db, message);
    return;
  }
  if (target.profileType === "trae-cli") {
    await failMessage(
      db,
      messageId,
      "This expert runs a local CLI runtime and does not support async consultation",
    );
    if (message.creditsCharged > 0) await safeRefund(db, message);
    return;
  }

  await db
    .update(agentMessages)
    .set({ state: "dispatched", modifiedAt: new Date() })
    .where(eq(agentMessages.id, messageId));

  // 影子会话：复用 sendMessageSync 的咨询执行链（owner 知识检索 + 计量）
  const [session] = await db
    .insert(chatSessions)
    .values({
      userId: message.requesterUserId,
      title: shadowTitle(message.question),
      agentProfileId: target.profileId,
      ownerUserId: target.publicationUserId,
      publicationId: target.publicationId,
    })
    .returning({ id: chatSessions.id });

  try {
    const client = await buildImpersonatingTRPCClient(message.requesterUserId);
    const result = await client.chats.sendMessageSync({
      sessionId: session!.id,
      content: message.question,
    });
    if (result.content) {
      await db
        .update(agentMessages)
        .set({
          state: "answered",
          answer: result.content,
          sessionId: session!.id,
          modifiedAt: new Date(),
        })
        .where(eq(agentMessages.id, messageId));
      // 分成结算：publish方拿 (1 - feeRatio) * creditsCharged
      if (message.creditsCharged > 0) {
        const feeRatio =
          target.profileType === "hosted"
            ? serverConfig.consultation.hostedPlatformFeeRatio
            : serverConfig.consultation.externalPlatformFeeRatio;
        const publisherAmount = Math.round(
          message.creditsCharged * (1 - feeRatio),
        );
        if (publisherAmount > 0) {
          await CreditsService.creditCredits(
            db,
            target.publicationUserId,
            publisherAmount,
            "consultation_payout",
            {
              referenceType: "agentMessages",
              referenceId: messageId,
            },
          );
        }
        logger.info(
          `[agentMessage][${jobId}] payout: requester=${message.requesterUserId} charged=${message.creditsCharged}, publisher=${target.publicationUserId} gets=${publisherAmount} (feeRatio=${feeRatio})`,
        );
      }
      logger.info(
        `[agentMessage][${jobId}] message ${messageId} answered (session=${session!.id})`,
      );
    } else {
      await failMessage(
        db,
        messageId,
        result.error ?? "Target agent returned an empty answer",
        session!.id,
      );
      if (message.creditsCharged > 0) await safeRefund(db, message);
    }
  } catch (e) {
    // sendMessageSync 抛错（发布下架 / 计费封顶 / 端到端超时等）
    await failMessage(
      db,
      messageId,
      e instanceof Error ? e.message : String(e),
      session!.id,
    );
    if (message.creditsCharged > 0) await safeRefund(db, message);
  }
}

async function failMessage(
  db: typeof import("@saiye/db").db,
  messageId: string,
  note: string,
  sessionId?: string,
) {
  await db
    .update(agentMessages)
    .set({
      state: "failed",
      note: note.slice(0, 500),
      ...(sessionId ? { sessionId } : {}),
      modifiedAt: new Date(),
    })
    .where(eq(agentMessages.id, messageId));
  logger.warn(`[agentMessage] message ${messageId} failed: ${note}`);
}

/**
 * 安全退款：检查是否已 refund（防 worker 重试导致 double-refund）。
 */
async function safeRefund(
  db: typeof import("@saiye/db").db,
  message: { id: string; requesterUserId: string; creditsCharged: number },
) {
  if (message.creditsCharged <= 0) return;
  try {
    const [refunded] = await db
      .select({ n: sql<number>`1` })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, message.requesterUserId),
          eq(creditTransactions.referenceId, message.id),
          eq(creditTransactions.type, "refund"),
        ),
      )
      .limit(1);
    if (refunded) {
      logger.info(
        `[agentMessage] message ${message.id} already refunded, skipping`,
      );
      return;
    }
    await CreditsService.creditCredits(
      db,
      message.requesterUserId,
      message.creditsCharged,
      "refund",
      { referenceType: "agentMessages", referenceId: message.id },
    );
    logger.info(
      `[agentMessage] refunded ${message.creditsCharged} credits for ${message.id}`,
    );
  } catch (e) {
    logger.error(
      `[agentMessage] safeRefund failed for ${message.id}: ${String(e)}`,
    );
  }
}
