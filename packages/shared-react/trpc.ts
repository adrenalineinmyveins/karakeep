"use client";

import { createTRPCContext } from "@trpc/tanstack-react-query";

import type { AppRouter } from "@saiye/trpc/routers/_app";

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export {
  TRPC_MAX_URL_LENGTH_EXTERNAL,
  TRPC_MAX_URL_LENGTH_INTERNAL,
} from "@saiye/shared/trpc";
