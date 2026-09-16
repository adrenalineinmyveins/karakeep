import { workerStatsCounter } from "metrics";
import { withWorkerEventLog, withWorkerTracing } from "workerTracing";

import type { ZConceptCompilationRequest } from "@saiye/shared-server";
import {
  addLogFields,
  ConceptCompilationQueue,
  zConceptCompilationRequestSchema,
} from "@saiye/shared-server";
import { InferenceClientFactory } from "@saiye/shared/inference";
import logger from "@saiye/shared/logger";
import { DequeuedJob, getQueueClient } from "@saiye/shared/queueing";

import { compileConceptPage, markConceptFailure } from "./compiler";

async function attemptMarkFailure(jobData: object | undefined, error: string) {
  if (!jobData) {
    return;
  }
  try {
    const request = zConceptCompilationRequestSchema.parse(jobData);
    await markConceptFailure(request.conceptId, error);
  } catch (e) {
    logger.error(`Something went wrong when marking concept failure: ${e}`);
  }
}

export class ConceptWorker {
  static async build() {
    logger.info("Starting concept compilation worker ...");
    const worker =
      (await getQueueClient())!.createRunner<ZConceptCompilationRequest>(
        ConceptCompilationQueue,
        {
          run: withWorkerTracing(
            "conceptWorker.run",
            withWorkerEventLog("conceptWorker.run", runConceptCompilation),
          ),
          onComplete: async (job) => {
            workerStatsCounter.labels("concept", "completed").inc();
            logger.info(`[concepts][${job.id}] Completed successfully`);
            return Promise.resolve();
          },
          onError: async (job) => {
            workerStatsCounter.labels("concept", "failed").inc();
            logger.error(
              `[concepts][${job.id}] concept compilation job failed: ${job.error}\n${job.error.stack}`,
            );
            if (job.numRetriesLeft == 0) {
              workerStatsCounter.labels("concept", "failed_permanent").inc();
              // Keep the previous content readable; only flip the status.
              await attemptMarkFailure(job?.data, String(job.error));
            }
            return Promise.resolve();
          },
        },
        {
          concurrency: 1,
          pollIntervalMs: 1000,
          timeoutSecs: 300,
          validator: zConceptCompilationRequestSchema,
        },
      );

    return worker;
  }
}

async function runConceptCompilation(
  job: DequeuedJob<ZConceptCompilationRequest>,
) {
  const { conceptId } = job.data;
  const inferenceClient = InferenceClientFactory.build();
  if (!inferenceClient) {
    await markConceptFailure(
      conceptId,
      "No inference client configured (missing OPENAI_API_KEY / INFERENCE settings)",
    );
    logger.warn(
      `[concepts][${job.id}] No inference client configured, marking concept ${conceptId} as failed`,
    );
    return;
  }

  addLogFields<"conceptWorker.run">({
    "conceptPage.id": conceptId,
  });

  const result = await compileConceptPage(
    conceptId,
    inferenceClient,
    job.abortSignal,
  );
  if (result === "missing") {
    logger.info(
      `[concepts][${job.id}] Concept page ${conceptId} no longer exists, skipping`,
    );
  }
}
