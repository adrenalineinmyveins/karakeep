"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Coins, Hourglass, Search, X } from "lucide-react";

import { useDebounce } from "@saiye/shared-react/hooks/use-debounce";
import { useTRPC } from "@saiye/shared-react/trpc";

import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/lib/i18n/client";

/** 咨询广场：领域专家发布卡片，可发起同步会话或异步咨询 */
export default function ConsultGrid() {
  const api = useTRPC();
  const router = useRouter();
  const { t } = useTranslation();

  // 搜索：输入防抖后作为 discover 的 query 过滤（清空 = 不过滤）
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);

  const { data, isLoading } = useQuery(
    api.agentPublications.discover.queryOptions(
      debouncedSearch.trim() ? { query: debouncedSearch.trim() } : undefined,
    ),
  );

  const publications = data?.publications ?? [];

  const runtimeLabel = {
    hosted: t("consult.runtime_hosted"),
    "openai-compatible": t("consult.runtime_openai"),
    "trae-cli": t("consult.runtime_cli"),
  } as const;

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

  // 异步咨询：留一条问题消息，专家侧异步处理后可在收件箱查看回答
  const [asyncTarget, setAsyncTarget] = useState<
    (typeof publications)[number] | null
  >(null);
  const [question, setQuestion] = useState("");

  const sendMessage = useMutation(
    api.agentMessages.send.mutationOptions({
      onSuccess: () => {
        toast({ description: t("consult.async_sent") });
        setAsyncTarget(null);
        router.push("/dashboard/consult/inbox");
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

  return (
    <div className="flex flex-col gap-4">
      <div className="relative sm:w-72">
        <Input
          type="text"
          placeholder={t("consult.search_placeholder")}
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

      {isLoading ? (
        <div className="grid items-start gap-4 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : publications.length == 0 ? (
        <p className="rounded-md bg-muted p-4 text-sm text-muted-foreground">
          {t("consult.empty")}
        </p>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2">
          {publications.map((p) => (
            <div
              key={p.id}
              className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm"
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                  {p.runtime === "hosted" && <Bot className="size-3.5" />}
                  {runtimeLabel[p.runtime]}
                </span>
                {p.status === "delisting" && (
                  <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-600">
                    <Hourglass className="size-3.5" />
                    {t("consult.delisting")}
                  </span>
                )}
                <span className="ml-auto">
                  {p.createdAt?.toLocaleDateString()}
                </span>
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
              {/* D2 喂养画像：专家简介 + 自动专长标签（未生成则不展示） */}
              {p.bio && (
                <p className="line-clamp-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                  {p.bio}
                </p>
              )}
              {p.autoExpertise && p.autoExpertise.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {p.autoExpertise.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Coins className="size-4" />
                  {p.pricePerCall} {t("consult.price_per_call")}
                </span>
                {p.isOwn ? (
                  // 不能咨询自己的发布（服务端同样拒绝）
                  <span className="rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">
                    {t("consult.own_badge")}
                  </span>
                ) : (
                  <div className="flex items-center gap-2">
                    {/* trae-cli 型运行在所有者本地，不支持异步咨询 */}
                    {p.runtime !== "trae-cli" && (
                      <ActionButton
                        ignoreDemoMode={true}
                        loading={false}
                        variant="outline"
                        onClick={() => {
                          setQuestion("");
                          setAsyncTarget(p);
                        }}
                      >
                        {t("consult.async_start")}
                      </ActionButton>
                    )}
                    <ActionButton
                      ignoreDemoMode={true}
                      loading={startConsultation.isPending}
                      variant="outline"
                      onClick={() =>
                        startConsultation.mutate({ publicationId: p.id })
                      }
                    >
                      {t("consult.start")}
                    </ActionButton>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={!!asyncTarget}
        onOpenChange={(o) => {
          if (!o) setAsyncTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("consult.async_start")} · {asyncTarget?.title}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!asyncTarget) return;
              sendMessage.mutate({
                targetPublicationId: asyncTarget.id,
                question: question.trim(),
              });
            }}
            className="space-y-4"
          >
            <div className="grid gap-2">
              <Label htmlFor="async-question">
                {t("consult.async_question_label")}
              </Label>
              <Textarea
                id="async-question"
                rows={6}
                required
                maxLength={8000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setAsyncTarget(null)}
              >
                {t("actions.cancel")}
              </Button>
              <ActionButton
                ignoreDemoMode={true}
                type="submit"
                loading={sendMessage.isPending}
              >
                {t("consult.async_send")}
              </ActionButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
