import { workerStatsCounter } from "metrics";
import { withWorkerEventLog, withWorkerTracing } from "workerTracing";

import {
  addLogFields,
  MirrorExportQueue,
  ZMirrorExportRequest,
  zMirrorExportRequestSchema,
} from "@saiye/shared-server";
import serverConfig from "@saiye/shared/config";
import logger from "@saiye/shared/logger";
import { DequeuedJob, getQueueClient } from "@saiye/shared/queueing";

import {
  deleteConceptMirrorFile,
  deleteMirrorFile,
  exportBookmarkMirror,
  exportConceptMirror,
  rebuildUserIndex,
  rebuildUserMirror,
} from "./mirrorExport";

export class MirrorExportWorker {
  static async build() {
    logger.info("Starting mirror export worker ...");
    const worker = (await getQueueClient())!.createRunner<ZMirrorExportRequest>(
      MirrorExportQueue,
      {
        run: withWorkerTracing(
          "mirrorExportWorker.run",
          withWorkerEventLog("mirrorExportWorker.run", runMirrorExport),
        ),
        onComplete: async (job) => {
          workerStatsCounter.labels("mirrorExport", "completed").inc();
          const jobId = job.id;
          logger.info(`[mirrorExport][${jobId}] Completed successfully`);
          return Promise.resolve();
        },
        onError: async (job) => {
          workerStatsCounter.labels("mirrorExport", "failed").inc();
          if (job.numRetriesLeft == 0) {
            workerStatsCounter.labels("mirrorExport", "failed_permanent").inc();
          }
          const jobId = job.id;
          logger.error(
            `[mirrorExport][${jobId}] mirror export job failed: ${job.error}\n${job.error.stack}`,
          );
          return Promise.resolve();
        },
      },
      {
        concurrency: 2,
        pollIntervalMs: 1000,
        timeoutSecs: 300,
        validator: zMirrorExportRequestSchema,
      },
    );

    return worker;
  }
}

async function runMirrorExport(job: DequeuedJob<ZMirrorExportRequest>) {
  const jobId = job.id;
  const { type } = job.data;
  switch (type) {
    case "export": {
      const { bookmarkId } = job.data;
      addLogFields<"mirrorExportWorker.run">({
        "bookmark.id": bookmarkId,
        "mirrorExport.type": type,
      });
      const result = await exportBookmarkMirror(bookmarkId);
      if (result === "missing") {
        // The bookmark was deleted between enqueue and run; nothing to do.
        logger.info(
          `[mirrorExport][${jobId}] Bookmark ${bookmarkId} no longer exists, skipping export`,
        );
      }
      break;
    }
    case "delete": {
      const { bookmarkId, userId } = job.data;
      addLogFields<"mirrorExportWorker.run">({
        "bookmark.id": bookmarkId,
        "mirrorExport.type": type,
      });
      await deleteMirrorFile(serverConfig.mirrorExport.dir, userId, bookmarkId);
      // The bookmark is gone from the DB; drop its index entry as well.
      await rebuildUserIndex(userId);
      break;
    }
    case "rebuild": {
      const { userId } = job.data;
      addLogFields<"mirrorExportWorker.run">({
        "mirrorExport.type": type,
      });
      await rebuildUserMirror(userId);
      break;
    }
    case "concept_export": {
      const { conceptId } = job.data;
      addLogFields<"mirrorExportWorker.run">({
        "conceptPage.id": conceptId,
        "mirrorExport.type": type,
      });
      const result = await exportConceptMirror(conceptId);
      if (result === "missing") {
        logger.info(
          `[mirrorExport][${jobId}] Concept page ${conceptId} no longer exists, skipping export`,
        );
      }
      break;
    }
    case "concept_delete": {
      const { userId, slug } = job.data;
      addLogFields<"mirrorExportWorker.run">({
        "mirrorExport.type": type,
      });
      await deleteConceptMirrorFile(
        serverConfig.mirrorExport.dir,
        userId,
        slug,
      );
      await rebuildUserIndex(userId);
      break;
    }
  }
}
