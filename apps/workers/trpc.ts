import { createCallerFactory } from "@saiye/trpc";
import { buildImpersonatingAuthedContext as buildAuthedContext } from "@saiye/trpc/lib/impersonate";
import { appRouter } from "@saiye/trpc/routers/_app";

export const buildImpersonatingAuthedContext = buildAuthedContext;

/**
 * This is only safe to use in the context of a worker.
 */
export async function buildImpersonatingTRPCClient(userId: string) {
  const createCaller = createCallerFactory(appRouter);

  return createCaller(await buildImpersonatingAuthedContext(userId));
}
