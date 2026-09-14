"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Link2Off, Share2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n/client";
import { useTRPC } from "@saiye/shared-react/trpc";
import type { AssetExportType } from "@saiye/shared/types/assetExport";

/**
 * 行内分享按钮组（C2）：
 * - 未分享：[Share2] 创建分享并复制链接
 * - 已分享：[Link2] 复制链接 + [Link2Off] 停止分享
 *
 * bare=true 用 WidgetGrid 卡片的原生小按钮风格，否则用 shadcn ghost icon 按钮。
 */
export default function AssetShareButtons({
  assetType,
  assetId,
  bare = false,
}: {
  assetType: AssetExportType;
  assetId: string;
  bare?: boolean;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const { data } = useQuery(api.sharedAssets.listMine.queryOptions());
  const share = (data?.shares ?? []).find(
    (s) => s.assetType === assetType && s.assetId === assetId,
  );

  const copyLink = (token: string) => {
    void navigator.clipboard.writeText(
      `${window.location.origin}/share/${token}`,
    );
    toast.success(t("shared_assets.link_copied"));
  };

  const createMutation = useMutation(
    api.sharedAssets.create.mutationOptions({
      onSuccess: (res) => {
        copyLink(res.shareToken);
        queryClient.invalidateQueries(api.sharedAssets.listMine.pathFilter());
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const revokeMutation = useMutation(
    api.sharedAssets.revoke.mutationOptions({
      onSuccess: () => {
        toast.success(t("shared_assets.stopped"));
        queryClient.invalidateQueries(api.sharedAssets.listMine.pathFilter());
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const bareClass =
    "rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";

  if (share) {
    return (
      <>
        {bare ? (
          <button
            type="button"
            className={bareClass}
            title={t("shared_assets.copy_link")}
            onClick={() => copyLink(share.shareToken)}
          >
            <Link2 size={14} />
          </button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("shared_assets.copy_link")}
            onClick={() => copyLink(share.shareToken)}
          >
            <Link2 size={16} />
          </Button>
        )}
        {bare ? (
          <button
            type="button"
            className={bareClass}
            title={t("shared_assets.stop_sharing")}
            disabled={revokeMutation.isPending}
            onClick={() => revokeMutation.mutate({ id: share.id })}
          >
            <Link2Off size={14} />
          </button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("shared_assets.stop_sharing")}
            disabled={revokeMutation.isPending}
            onClick={() => revokeMutation.mutate({ id: share.id })}
          >
            <Link2Off size={16} />
          </Button>
        )}
      </>
    );
  }

  const onCreate = () => createMutation.mutate({ assetType, assetId });

  return bare ? (
    <button
      type="button"
      className={bareClass}
      title={t("shared_assets.share")}
      disabled={createMutation.isPending}
      onClick={onCreate}
    >
      <Share2 size={14} />
    </button>
  ) : (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      title={t("shared_assets.share")}
      disabled={createMutation.isPending}
      onClick={onCreate}
    >
      <Share2 size={16} />
    </Button>
  );
}
