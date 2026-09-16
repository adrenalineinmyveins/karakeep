import { eq, inArray } from "drizzle-orm";
import cron from "node-cron";

import { db } from "@saiye/db";
import { bookmarkLists, bookmarkTags, conceptPages } from "@saiye/db/schema";
import {
  triggerConceptCompilation,
  triggerConceptMirrorDelete,
} from "@saiye/shared-server";
import logger from "@saiye/shared/logger";

import { collectSourceSet, computeSourceHash } from "./compiler";

// A "generating" page that hasn't produced a new compileVersion within this
// window is treated as crashed and re-queued.
const GENERATING_STUCK_MS = 10 * 60 * 1000;

export async function reconcileConceptPages(): Promise<{
  requeued: number;
  deleted: number;
}> {
  const pages = await db.query.conceptPages.findMany();

  // Existing anchor ids for orphan detection (bulk-loaded, no N+1)
  const tagIds = new Set(
    pages.some((p) => p.anchorType === "tag")
      ? (
          await db
            .select({ id: bookmarkTags.id })
            .from(bookmarkTags)
            .where(
              inArray(
                bookmarkTags.id,
                pages
                  .filter((p) => p.anchorType === "tag")
                  .map((p) => p.anchorId),
              ),
            )
        ).map((r) => r.id)
      : [],
  );
  const listIds = new Set(
    pages.some((p) => p.anchorType === "list")
      ? (
          await db
            .select({ id: bookmarkLists.id })
            .from(bookmarkLists)
            .where(
              inArray(
                bookmarkLists.id,
                pages
                  .filter((p) => p.anchorType === "list")
                  .map((p) => p.anchorId),
              ),
            )
        ).map((r) => r.id)
      : [],
  );

  let requeued = 0;
  let deleted = 0;

  for (const page of pages) {
    // 1. Orphaned anchor: the tag/list was deleted -> drop the page and its
    //    mirror file (sources cascade away with the page row).
    const anchorExists =
      page.anchorType === "tag"
        ? tagIds.has(page.anchorId)
        : listIds.has(page.anchorId);
    if (!anchorExists) {
      await db.delete(conceptPages).where(eq(conceptPages.id, page.id));
      await triggerConceptMirrorDelete(page.userId, page.slug);
      deleted++;
      continue;
    }

    // 2. Stuck "generating": crash recovery.
    if (page.status === "generating") {
      const stuckMs = Date.now() - (page.lastSourceChangeAt?.getTime() ?? 0);
      if (stuckMs > GENERATING_STUCK_MS) {
        await db
          .update(conceptPages)
          .set({ status: "pending" })
          .where(eq(conceptPages.id, page.id));
        await triggerConceptCompilation(page.id);
        requeued++;
      }
      continue;
    }

    // 3. Freshness check: recompute the source fingerprint and compare with
    //    the snapshot from the last compile. No write-path hooks needed —
    //    this catches tag attach/detach, list moves, bookmark edits and
    //    bookmark deletions (source rows cascade away) alike.
    if (page.status === "ready" || page.status === "stale") {
      const sources = await collectSourceSet(
        page.userId,
        page.anchorType,
        page.anchorId,
      );
      const hash = computeSourceHash(sources);
      const isStale =
        sources.length !== page.sourceCount || hash !== page.sourceContentHash;
      if (isStale && page.status === "ready") {
        await db
          .update(conceptPages)
          .set({ status: "stale" })
          .where(eq(conceptPages.id, page.id));
      }
      if (isStale) {
        await triggerConceptCompilation(page.id);
        requeued++;
      }
    }
  }

  if (requeued > 0 || deleted > 0) {
    logger.info(
      `[concepts] Reconciliation done: ${requeued} pages requeued, ${deleted} orphaned pages deleted`,
    );
  }
  return { requeued, deleted };
}

export const ConceptSchedulingWorker = cron.schedule(
  "0 * * * *",
  () => {
    reconcileConceptPages().catch((e) => {
      logger.error(`[concepts] Reconciliation failed: ${e}`);
    });
  },
  {
    runOnInit: false,
    scheduled: false,
  },
);
