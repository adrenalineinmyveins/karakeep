"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Bot,
  ExternalLink,
  LayoutDashboard,
  Search,
  TextQuote,
  X,
} from "lucide-react";
import { useInView } from "react-intersection-observer";
import { z } from "zod";

import { useDebounce } from "@saiye/shared-react/hooks/use-debounce";
import { useTRPC } from "@saiye/shared-react/trpc";
import { zWidgetManifestSchema } from "@saiye/shared/types/widgets";

import ShareForkButton from "@/components/shared/ShareForkButton";
import WidgetHost from "@/components/dashboard/widgets/WidgetHost";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTranslation } from "@/lib/i18n/client";

type AssetType = "widget" | "agentProfile" | "prompt";
type Tab = "all" | AssetType;

const typeLabelKey = {
  widget: "shared_assets.type_widget",
  agentProfile: "shared_assets.type_agent_profile",
  prompt: "shared_assets.type_prompt",
} as const;

/** widget 分享快照的最小校验（预览只需 manifest + code） */
const zPreviewPayload = z.object({
  manifest: zWidgetManifestSchema,
  code: z.string().min(1),
});

/** widget 分享的懒加载沙箱预览：卡片进入视口才拉快照渲染 */
function WidgetSharePreview({ token }: { token: string }) {
  const api = useTRPC();
  const { t } = useTranslation();
  const { ref, inView } = useInView({
    triggerOnce: true,
    rootMargin: "200px",
  });
  const { data, isLoading } = useQuery(
    api.publicSharedAssets.get.queryOptions({ token }, { enabled: inView }),
  );

  const parsedResult = data ? zPreviewPayload.safeParse(data.payload) : null;
  const parsed = parsedResult?.success ? parsedResult.data : null;

  return (
    <div ref={ref} className="overflow-hidden rounded-lg border bg-muted/30">
      {inView && isLoading && (
        <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
          {t("discover.loading_preview")}
        </div>
      )}
      {parsed && !isLoading && (
        <WidgetHost
          manifest={parsed.manifest}
          code={parsed.code}
          mode="preview"
        />
      )}
      {inView && !isLoading && !parsed && (
        <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
          {t("discover.preview_unavailable")}
        </div>
      )}
    </div>
  );
}

function DiscoverCard({
  asset,
}: {
  asset: {
    shareToken: string;
    assetType: AssetType;
    name: string;
    ownerName: string;
    isMine: boolean;
    createdAt: Date;
  };
}) {
  const { t } = useTranslation();
  const typeIcon =
    asset.assetType === "widget" ? (
      <LayoutDashboard className="size-3.5" />
    ) : asset.assetType === "agentProfile" ? (
      <Bot className="size-3.5" />
    ) : (
      <TextQuote className="size-3.5" />
    );

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
          {typeIcon}
          {t(typeLabelKey[asset.assetType])}
        </span>
        {asset.isMine && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
            {t("discover.yours")}
          </span>
        )}
        <span className="ml-auto">{asset.createdAt.toLocaleDateString()}</span>
      </div>
      <div className="break-all text-base font-semibold">{asset.name}</div>
      <div className="text-sm text-muted-foreground">
        {t("shared_assets.shared_by", { name: asset.ownerName })}
      </div>
      {asset.assetType === "widget" && (
        <WidgetSharePreview token={asset.shareToken} />
      )}
      <div className="mt-auto flex items-center gap-2 pt-1">
        <ShareForkButton token={asset.shareToken} />
        <Button variant="outline" asChild>
          <Link href={`/share/${asset.shareToken}`} target="_blank">
            <ExternalLink className="mr-2 size-4" />
            {t("discover.view")}
          </Link>
        </Button>
      </div>
    </div>
  );
}

export default function DiscoverGrid() {
  const api = useTRPC();
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("all");
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);

  const input = {
    ...(tab !== "all" ? { assetType: tab } : {}),
    ...(debouncedSearch.trim() ? { query: debouncedSearch.trim() } : {}),
  };

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isPending } =
    useInfiniteQuery(
      api.sharedAssets.listPublic.infiniteQueryOptions(input, {
        initialCursor: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }),
    );

  const { ref: loadMoreRef, inView: loadMoreButtonInView } = useInView();
  useEffect(() => {
    if (loadMoreButtonInView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [loadMoreButtonInView]);

  const assets = data?.pages.flatMap((p) => p.assets) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="all">{t("discover.tab_all")}</TabsTrigger>
            <TabsTrigger value="widget">
              {t("shared_assets.type_widget")}
            </TabsTrigger>
            <TabsTrigger value="agentProfile">
              {t("shared_assets.type_agent_profile")}
            </TabsTrigger>
            <TabsTrigger value="prompt">
              {t("shared_assets.type_prompt")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative sm:ml-auto sm:w-72">
          <Input
            type="text"
            placeholder={t("discover.search_placeholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            startIcon={<Search className="size-4 text-muted-foreground" />}
            endIcon={
              searchInput && (
                <button
                  onClick={() => setSearchInput("")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              )
            }
            className="w-full"
          />
        </div>
      </div>

      {isPending && (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          {t("discover.loading")}
        </div>
      )}
      {!isPending && assets.length == 0 && (
        <p className="rounded-md bg-muted p-4 text-sm text-muted-foreground">
          {t("discover.empty")}
        </p>
      )}
      <div className="grid items-start gap-4 md:grid-cols-2">
        {assets.map((asset) => (
          <DiscoverCard key={asset.shareToken} asset={asset} />
        ))}
      </div>
      {hasNextPage && (
        <div className="flex justify-center">
          <ActionButton
            ref={loadMoreRef}
            ignoreDemoMode={true}
            loading={isFetchingNextPage}
            onClick={() => fetchNextPage()}
            variant="ghost"
          >
            {t("actions.load_more")}
          </ActionButton>
        </div>
      )}
    </div>
  );
}
