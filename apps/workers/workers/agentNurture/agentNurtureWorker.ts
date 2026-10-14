import cron from "node-cron";

import { workerStatsCounter } from "metrics";
import { withWorkerEventLog, withWorkerTracing } from "workerTracing";

import { db } from "@saiye/db";
import { agentProfiles } from "@saiye/db/schema";
import { eq } from "drizzle-orm";
import {
  addLogFields,
  AgentNurtureQueue,
  zAgentNurtureRequestSchema,
} from "@saiye/shared-server";
import { InferenceClientFactory } from "@saiye/shared/inference";
import logger from "@saiye/shared/logger";
import { DequeuedJob, getQueueClient } from "@saiye/shared/queueing";

import { nurtureProfile, shouldNurture } from "./nurture";

import type { ZAgentNurtureRequest } from "@saiye/shared-server";

/**
 * D2 agent 喂养 worker：消费 nurture 队列，执行画像/记忆沉淀。
 * 触发来源：每小时 cron 评估（阈值 ≥20 条增量或 7 天兜底）幂等入队。
 */
export class AgentNurtureWorker {
  static async build() {
    logger.info("Starting agent nurture worker ...");
    const worker = (await getQueueClient())!.createRunner<ZAgentNurtureRequest>(
      AgentNurtureQueue,
      {
        run: withWorkerTracing(
          "agentNurtureWorker.run",
          withWorkerEventLog("agentNurtureWorker.run", runAgentNurture),
        ),
        onComplete: (job) => {
          workerStatsCounter.labels("agentNurture", "completed").inc();
          logger.info(`[agentNurture][${job.id}] Completed successfully`);
          return Promise.resolve();
        },
        onError: (job) => {
          workerStatsCounter.labels("agentNurture", "failed").inc();
          logger.error(
            `[agentNurture][${job.id}] nurture job failed: ${job.error}\n${job.error.stack}`,
          );
          return Promise.resolve();
        },
      },
      {
        concurrency: 1,
        pollIntervalMs: 1000,
        timeoutSecs: 180,
        validator: zAgentNurtureRequestSchema,
      },
    );

    return worker;
  }
}

async function runAgentNurture(job: DequeuedJob<ZAgentNurtureRequest>) {
  const { profileId } = job.data;
  addLogFields<"agentNurtureWorker.run">({
    "agent_profile.id": profileId,
  });

  const inferenceClient = InferenceClientFactory.build();
  if (!inferenceClient) {
    logger.warn(
      `[agentNurture][${job.id}] No inference client configured, skipping nurture for ${profileId}`,
    );
    return;
  }

  const result = await nurtureProfile(db, inferenceClient, profileId);
  if (result !== "done") {
    logger.info(
      `[agentNurture][${job.id}] profile ${profileId} ${result}, skipping LLM call`,
    );
  }
}

/** 每小时扫描 hosted 档案：增量达阈值或超兜底周期则幂等入队（D2-b 成本控制） */
async function scheduleNurtureRuns() {
  const profiles = await db
    .select({
      id: agentProfiles.id,
      userId: agentProfiles.userId,
      type: agentProfiles.type,
      nurtureAuto: agentProfiles.nurtureAuto,
      knowledgeScope: agentProfiles.knowledgeScope,
      nurtureState: agentProfiles.nurtureState,
    })
    .from(agentProfiles)
    .where(eq(agentProfiles.type, "hosted"));

  let enqueued = 0;
  for (const profile of profiles) {
    if (!(await shouldNurture(db, profile))) {
      continue;
    }
    await AgentNurtureQueue.enqueue(
      { profileId: profile.id },
      // 固定幂等键：cron 间隔内重复评估自动合并，不堆积
      { idempotencyKey: `nurture:${profile.id}` },
    );
    enqueued++;
  }
  if (enqueued > 0) {
    logger.info(
      `[agentNurture] scheduler enqueued ${enqueued}/${profiles.length} hosted profiles`,
    );
  }
}

export const AgentNurtureSchedulingWorker = cron.schedule(
  "0 * * * *",
  () => {
    scheduleNurtureRuns().catch((e) => {
      logger.error(`[agentNurture] Scheduling failed: ${e}`);
    });
  },
  {
    runOnInit: false,
    scheduled: false,
  },
);
