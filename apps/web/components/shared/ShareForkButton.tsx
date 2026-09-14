"use client";

import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { GitFork } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n/client";
import { useTRPC } from "@saiye/shared-react/trpc";

const FORK_REDIRECTS = {
  agentProfile: "/settings/agents",
  widget: "/dashboard/widgets",
  prompt: "/settings/ai",
} as const;

/** 公开分享页的 fork 按钮：复制快照为当前用户资产后跳转对应管理页 */
export default function ShareForkButton({ token }: { token: string }) {
  const api = useTRPC();
  const router = useRouter();
  const { t } = useTranslation();

  const forkMutation = useMutation(
    api.sharedAssets.fork.mutationOptions({
      onSuccess: (res) => {
        toast.success(
          res.needsApiKey
            ? t("shared_assets.forked_needs_api_key")
            : t("shared_assets.forked"),
        );
        router.push(FORK_REDIRECTS[res.assetType]);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Button
      disabled={forkMutation.isPending}
      onClick={() => forkMutation.mutate({ token })}
    >
      <GitFork className="mr-2 size-4" />
      {t("shared_assets.fork")}
    </Button>
  );
}
