import { useQuery } from "@tanstack/react-query";

import {
  ClientConfigProvider as SharedClientConfigProvider,
  useClientConfig,
} from "@saiye/shared-react/providers/client-config-provider";
import { useTRPC } from "@saiye/shared-react/trpc";

export function ClientConfigProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const api = useTRPC();
  const { data } = useQuery(
    api.config.clientConfig.queryOptions(undefined, {
      staleTime: 5 * 60 * 1000,
      retry: 1,
    }),
  );

  return (
    <SharedClientConfigProvider value={data}>
      {children}
    </SharedClientConfigProvider>
  );
}

export { useClientConfig };
