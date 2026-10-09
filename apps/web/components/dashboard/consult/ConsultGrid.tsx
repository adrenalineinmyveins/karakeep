"use client";

import { Coins, GraduationCap, Hourglass } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";

import { useTRPC } from "@saiye/shared-react/trpc";

import { ActionButton } from "@/components/ui/action-button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { useTranslation } from "@/lib/i18n/client";

/** 咨询广场：领域专家发布卡片，一键发起咨询会话 */
export default function ConsultGrid() {
  const api = useTRPC();
  const router = useRouter();
  const { t } = useTranslation();

  const { data, isLoading } = useQuery(
    api.agentPublications.discover.queryOptions(),
  );

  // D2 咨询会话：基于发布创建（与发布绑定专家，不能咨询自己的发布）
  const startConsultation = useMutation(
    api.chats.createSession.mutationOptions({
      onSuccess: () => {
        // chat 页自动选中最近会话（modifiedAt 倒序），新会话即首项
        router.push("/dashboard/chat");
      },
      onError: (e) => {
        toast({
          title: t("consult.start_failed"),
          description: e.message,
          variant: "destructive",
        });
      },
    }),
  );

  if (isLoading) {
    return (
      <div className="grid items-start gap-4 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full" />
        ))}
      </div>
    );
  }

  const publications = data?.publications ?? [];
  if (publications.length == 0) {
    return (
      <p className="rounded-md bg-muted p-4 text-sm text-muted-foreground">
        {t("consult.empty")}
      </p>
    );
  }

  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      {publications.map((p) => (
        <div
          key={p.id}
          className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm"
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
              <GraduationCap className="size-3.5" />
              {t("consult.expert")}
            </span>
            {p.status === "delisting" && (
              <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-600">
                <Hourglass className="size-3.5" />
                {t("consult.delisting")}
              </span>
            )}
            <span className="ml-auto">{p.createdAt?.toLocaleDateString()}</span>
          </div>
          <div className="break-all text-base font-semibold">{p.title}</div>
          <div className="text-sm text-muted-foreground">
            {t("consult.by_owner", { name: p.ownerName })}
          </div>
          {p.description && (
            <p className="line-clamp-3 text-sm text-foreground/80">
              {p.description}
            </p>
          )}
          <div className="mt-auto flex items-center justify-between gap-2 pt-1">
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Coins className="size-4" />
              {p.pricePerCall} {t("consult.price_per_call")}
            </span>
            <ActionButton
              ignoreDemoMode={true}
              loading={startConsultation.isPending}
              variant="outline"
              onClick={() => startConsultation.mutate({ publicationId: p.id })}
            >
              {t("consult.start")}
            </ActionButton>
          </div>
        </div>
      ))}
    </div>
  );
}
