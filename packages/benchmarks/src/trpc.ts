import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "@saiye/trpc/routers/_app";

export type TrpcClient = ReturnType<typeof getTrpcClient>;

export function getTrpcClient(apiKey?: string) {
  if (!process.env.SAIYE_PORT) {
    throw new Error("SAIYE_PORT is not set. Did you start the containers?");
  }

  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        transformer: superjson,
        url: `http://localhost:${process.env.SAIYE_PORT}/api/trpc`,
        headers() {
          return {
            authorization: apiKey ? `Bearer ${apiKey}` : undefined,
          };
        },
      }),
    ],
  });
}
