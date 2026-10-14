import { eq } from "drizzle-orm";

import { workerStatsCounter } from "metrics";
import { withWorkerEventLog, withWorkerTracing } from "workerTracing";

import { db } from "@saiye/db";
import { agentProfiles, agentPublications } from "@saiye/db/schema";
import {
  addLogFields,
  AgentPublicationVectorQueue,
  zAgentPublicationVectorRequestSchema,
} from "@saiye/shared-server";
import { EmbeddingClientFactory } from "@saiye/shared/inference";
import logger from "@saiye/shared/logger";
import { getVectorStoreClient } from "@saiye/shared/vectorStore";
import { DequeuedJob, getQueueClient } from "@saiye/shared/queueing";

import type { ZAgentPublicationVectorRequest } from "@saiye/shared-server";

/**
 * D3-b 语义混合召回：发布向量化 worker。
 * 发布/更新/喂养画像刷新 → 生成 embedding 写入 vector store（id: pub:{id}）；
 * delist → 清向量。embedding/vector store 未配置时静默跳过（discover 退化为 ILIKE）。
 */

/** 向量文档 id 前缀（discover 反查 publicationId 用，保持与 worker 一致） */
export const PUBLICATION_VECTOR_PREFIX = "pub:";

export function publicationVectorId(publicationId: string): string {
  return `${PUBLICATION_VECTOR_PREFIX}${publicationId}`;
}

/** 喂给 embedding 的文本：标题 + 描述 + 标签 + 喂养画像（语义召回语料） */
export function buildPublicationVectorText(input: {
  title: string;
  description: string | null;
  tags: string[];
  bio: string | null;
  expertiseTags: string[] | null;
}): string {
  return [
    input.title,
    input.description ?? "",
    input.tags.join(" "),
    input.bio ?? "",
    (input.expertiseTags ?? []).join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

export class AgentPublicationVectorWorker {
  static async build() {
    logger.info("Starting agent publication vector worker ...");
    const worker =
      (await getQueueClient())!.createRunner<ZAgentPublicationVectorRequest>(
        AgentPublicationVectorQueue,
        {
          run: withWorkerTracing(
            "agentPublicationVectorWorker.run",
            withWorkerEventLog(
              "agentPublicationVectorWorker.run",
              runVectorTask,
            ),
          ),
          onComplete: (job) => {
            workerStatsCounter
              .labels("agentPublicationVector", "completed")
              .inc();
            logger.info(`[agentPubVector][${job.id}] Completed successfully`);
            return Promise.resolve();
          },
          onError: (job) => {
            workerStatsCounter.labels("agentPublicationVector", "failed").inc();
            logger.error(
              `[agentPubVector][${job.id}] vector job failed: ${job.error}`,
            );
            return Promise.resolve();
          },
        },
        {
          concurrency: 2,
          pollIntervalMs: 1000,
          timeoutSecs: 60,
          validator: zAgentPublicationVectorRequestSchema,
        },
      );

    return worker;
  }
}

async function runVectorTask(job: DequeuedJob<ZAgentPublicationVectorRequest>) {
  const { publicationId, mode } = job.data;
  addLogFields<"agentPublicationVectorWorker.run">({
    "agent_publication.id": publicationId,
  });

  const vectorStore = await getVectorStoreClient();
  if (!vectorStore) {
    logger.debug(
      `[agentPubVector][${job.id}] No vector store configured, skipping (discover falls back to ILIKE)`,
    );
    return;
  }

  if (mode === "delete") {
    await vectorStore.deleteVectors([publicationVectorId(publicationId)]);
    logger.info(
      `[agentPubVector][${job.id}] Deleted vector for ${publicationId}`,
    );
    return;
  }

  const [row] = await db
    .select({
      id: agentPublications.id,
      userId: agentPublications.userId,
      status: agentPublications.status,
      title: agentPublications.title,
      description: agentPublications.description,
      tags: agentPublications.tags,
      bio: agentProfiles.bio,
      expertiseTags: agentProfiles.expertiseTags,
    })
    .from(agentPublications)
    .innerJoin(
      agentProfiles,
      eq(agentProfiles.id, agentPublications.agentProfileId),
    )
    .where(eq(agentPublications.id, publicationId))
    .limit(1);
  if (!row || row.status === "delisted") {
    // 已下架/不存在：清掉残留向量即可
    await vectorStore.deleteVectors([publicationVectorId(publicationId)]);
    return;
  }

  const embeddingClient = EmbeddingClientFactory.build();
  if (!embeddingClient) {
    logger.debug(
      `[agentPubVector][${job.id}] No embedding client configured, skipping`,
    );
    return;
  }

  const text = buildPublicationVectorText(row);
  const { embeddings } = await embeddingClient.generateEmbeddingFromText([
    text,
  ]);
  const vector = embeddings?.[0];
  if (!vector) {
    logger.warn(
      `[agentPubVector][${job.id}] Empty embedding for ${publicationId}, skipping`,
    );
    return;
  }

  await vectorStore.addVectors([
    {
      id: publicationVectorId(publicationId),
      userId: row.userId,
      vector,
    },
  ]);
  logger.info(
    `[agentPubVector][${job.id}] Upserted vector for ${publicationId} (${vector.length} dims)`,
  );
}
