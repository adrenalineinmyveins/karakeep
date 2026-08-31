"use client";

import type { UserLocalSettings } from "@/lib/userLocalSettings/types";
import React, { useState } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Session, SessionProvider } from "@/lib/auth/client";
import { UserLocalSettingsCtx } from "@/lib/userLocalSettings/bookmarksLayout";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  loggerLink,
  splitLink,
} from "@trpc/client";
import superjson from "superjson";

import type { ClientConfig } from "@karakeep/shared/config";
import type { AppRouter } from "@karakeep/trpc/routers/_app";
import { ClientConfigProvider } from "@karakeep/shared-react/providers/client-config-provider";
import {
  TRPC_MAX_URL_LENGTH_INTERNAL,
  TRPCProvider,
} from "@karakeep/shared-react/trpc";

import CustomI18nextProvider from "./i18n/provider";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR, we usually want to set some default staleTime
        // above 0 to avoid refetching immediately on the client
        staleTime: 60 * 1000,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined = undefined;

function getQueryClient() {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return makeQueryClient();
  } else {
    // Browser: make a new query client if we don't already have one
    // This is very important so we don't re-make a new client if React
    // supsends during the initial render. This may not be needed if we
    // have a suspense boundary BELOW the creation of the query client
    if (!browserQueryClient) browserQueryClient = makeQueryClient();
    return browserQueryClient;
  }
}

export default function Providers({
  children,
  session,
  clientConfig,
  userLocalSettings,
}: {
  children: React.ReactNode;
  session: Session | null;
  clientConfig: ClientConfig;
  userLocalSettings: UserLocalSettings;
}) {
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        loggerLink({
          enabled: (op) =>
            process.env.NODE_ENV === "development" ||
            (op.direction === "down" && op.result instanceof Error),
        }),
        splitLink({
          condition: (op) => op.type === "subscription",
          true: httpSubscriptionLink({
            url: `/api/trpc`,
            transformer: superjson,
          }),
          false: httpBatchLink({
            url: `/api/trpc`,
            maxURLLength: TRPC_MAX_URL_LENGTH_INTERNAL,
            transformer: superjson,
            headers() {
              // 页面通过 ?apiKey= 查询参数访问时（移动端 WebView），
              // 给客户端 tRPC 请求带上 Bearer 头，替代 cookie 会话
              if (typeof window !== "undefined") {
                const apiKey = new URLSearchParams(
                  window.location.search,
                ).get("apiKey");
                if (apiKey) {
                  return { Authorization: `Bearer ${apiKey}` };
                }
              }
              return {};
            },
          }),
        }),
      ],
    }),
  );

  return (
    <ClientConfigProvider value={clientConfig}>
      <UserLocalSettingsCtx.Provider value={userLocalSettings}>
        <SessionProvider session={session}>
          <QueryClientProvider client={queryClient}>
            <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
              <CustomI18nextProvider lang={userLocalSettings.lang}>
                <ThemeProvider
                  attribute="class"
                  defaultTheme="system"
                  enableSystem
                  disableTransitionOnChange
                >
                  <TooltipProvider delayDuration={0}>
                    {children}
                  </TooltipProvider>
                </ThemeProvider>
              </CustomI18nextProvider>
            </TRPCProvider>
          </QueryClientProvider>
        </SessionProvider>
      </UserLocalSettingsCtx.Provider>
    </ClientConfigProvider>
  );
}
