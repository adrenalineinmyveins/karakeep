import { promises as fsp } from "node:fs";
import path from "node:path";

import { z } from "zod";

import serverConfig from "@saiye/shared/config";
import { triggerMirrorRebuild } from "@saiye/shared-server";

import { authedProcedure, createRateLimitMiddleware, router } from "../index";

async function countMirrorFiles(userId: string): Promise<number> {
  try {
    const entries = await fsp.readdir(
      path.join(serverConfig.mirrorExport.dir, userId),
    );
    return entries.filter((e) => e.endsWith(".md")).length;
  } catch {
    // Directory doesn't exist yet or is unreadable
    return 0;
  }
}

export const mirrorAppRouter = router({
  status: authedProcedure
    .output(
      z.object({
        enabled: z.boolean(),
        dir: z.string(),
        fileCount: z.number(),
      }),
    )
    .query(async ({ ctx }) => ({
      enabled: serverConfig.mirrorExport.enabled,
      dir: serverConfig.mirrorExport.dir,
      fileCount: await countMirrorFiles(ctx.user.id),
    })),

  rebuild: authedProcedure
    .use(
      createRateLimitMiddleware({
        name: "mirror.rebuild",
        windowMs: 60 * 60 * 1000, // 1 hour window
        maxRequests: 5, // Max 5 rebuilds per hour
      }),
    )
    .mutation(async ({ ctx }) => {
      await triggerMirrorRebuild(ctx.user.id);
    }),
});
