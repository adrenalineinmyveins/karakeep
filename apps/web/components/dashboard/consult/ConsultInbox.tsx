"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";

import { useTRPC } from "@saiye/shared-react/trpc";

import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/** 咨询信箱消息行（listOutgoing/listIncoming 公共字段） */
interface AgentMessageRow {
  id: string;
  question: string;
  answer: string | null;
  state:
    | "pending"
    | "dispatched"
    | "answered"
    | "need_input"
    | "expired"
    | "failed";
  note: string | null;
  expiresAt: Date;
  createdAt: Date | null;
  modifiedAt: Date | null;
  targetPublicationId: string;
}

const stateLabelKey = {
  pending: "consult.state_pending",
  dispatched: "consult.state_dispatched",
  answered: "consult.state_answered",
  need_input: "consult.state_need_input",
  expired: "consult.state_expired",
  failed: "consult.state_failed",
} as const;

const stateBadgeClass = {
  pending: "bg-muted text-muted-foreground",
  dispatched: "bg-muted text-muted-foreground",
  answered: "bg-emerald-500/10 text-emerald-600",
  need_input: "bg-amber-500/10 text-amber-600",
  expired: "bg-red-500/10 text-red-600",
  failed: "bg-red-500/10 text-red-600",
} as const;

function MessageRow({
  message,
  canRetry,
}: {
  message: AgentMessageRow;
  canRetry: boolean;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [showAnswer, setShowAnswer] = useState(false);
  const [replyText, setReplyText] = useState("");

  // 重试仅发起方可调（failed/expired 且未超过 expiresAt，服务端校验）
  const retryMutation = useMutation(
    api.agentMessages.retry.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries(
          api.agentMessages.listOutgoing.pathFilter(),
        ),
      onError: (e) => toast({ description: e.message, variant: "destructive" }),
    }),
  );

  // D4-g 反问回复：专家澄清后请求方补充信息（need_input → 重新入队）
  const replyMutation = useMutation(
    api.agentMessages.reply.mutationOptions({
      onSuccess: () => {
        setReplyText("");
        toast({ description: t("consult.reply_sent") });
        queryClient.invalidateQueries(
          api.agentMessages.listOutgoing.pathFilter(),
        );
      },
      onError: (e) => toast({ description: e.message, variant: "destructive" }),
    }),
  );

  const retryable =
    canRetry &&
    (message.state === "failed" || message.state === "expired") &&
    message.expiresAt.getTime() > Date.now();

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs",
            stateBadgeClass[message.state],
          )}
        >
          {t(stateLabelKey[message.state])}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {message.createdAt?.toLocaleString()}
        </span>
      </div>
      <p className="line-clamp-2 text-sm font-medium">{message.question}</p>
      {message.state === "need_input" && canRetry && (
        <div className="flex flex-col gap-2">
          {message.note && (
            <div className="rounded-md bg-amber-500/5 p-3 text-sm">
              <span className="font-medium">
                {t("consult.clarification_question")}
              </span>{" "}
              {message.note}
            </div>
          )}
          <div className="flex items-start gap-2">
            <Textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={t("consult.reply_placeholder")}
              className="min-h-[60px] flex-1"
            />
            <ActionButton
              ignoreDemoMode={true}
              loading={replyMutation.isPending}
              disabled={!replyText.trim()}
              onClick={() =>
                replyMutation.mutate({
                  id: message.id,
                  clarification: replyText.trim(),
                })
              }
            >
              {t("consult.reply")}
            </ActionButton>
          </div>
        </div>
      )}
      {message.answer && (
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-fit px-2"
            onClick={() => setShowAnswer((v) => !v)}
          >
            <ChevronDown
              className={cn(
                "mr-1 size-4 transition-transform",
                showAnswer && "rotate-180",
              )}
            />
            {t("consult.view_answer")}
          </Button>
          {showAnswer && (
            <div className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">
              {message.answer}
            </div>
          )}
        </div>
      )}
      {retryable && (
        <ActionButton
          ignoreDemoMode={true}
          loading={retryMutation.isPending}
          variant="outline"
          className="w-fit"
          onClick={() => retryMutation.mutate({ id: message.id })}
        >
          {t("consult.retry")}
        </ActionButton>
      )}
    </div>
  );
}

function MessageList({
  messages,
  isLoading,
  canRetry,
}: {
  messages: AgentMessageRow[];
  isLoading: boolean;
  canRetry: boolean;
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (messages.length == 0) {
    return (
      <p className="rounded-md bg-muted p-4 text-sm text-muted-foreground">
        {t("consult.inbox_empty")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {messages.map((m) => (
        <MessageRow key={m.id} message={m} canRetry={canRetry} />
      ))}
    </div>
  );
}

/** 咨询信箱：我发出的 / 收到的 异步咨询消息（15s 轮询刷新） */
export default function ConsultInbox() {
  const api = useTRPC();
  const { t } = useTranslation();

  const outgoingQuery = useQuery(
    api.agentMessages.listOutgoing.queryOptions({}, { refetchInterval: 15000 }),
  );
  const incomingQuery = useQuery(
    api.agentMessages.listIncoming.queryOptions({}, { refetchInterval: 15000 }),
  );

  const queryClient = useQueryClient();

  // D5 实时推送：SSE 订阅后端事件，收到即刷新对应列表；15s 轮询仍作兜底
  useEffect(() => {
    const es = new EventSource("/api/realtime");
    es.onmessage = (e) => {
      let data: { type?: string };
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      if (data.type === "consult_incoming") {
        queryClient.invalidateQueries(
          api.agentMessages.listIncoming.pathFilter(),
        );
      } else if (data.type === "consult_outgoing") {
        queryClient.invalidateQueries(
          api.agentMessages.listOutgoing.pathFilter(),
        );
      }
    };
    return () => es.close();
  }, [api, queryClient]);

  return (
    <Tabs defaultValue="outgoing">
      <TabsList>
        <TabsTrigger value="outgoing">
          {t("consult.inbox_outgoing")}
        </TabsTrigger>
        <TabsTrigger value="incoming">
          {t("consult.inbox_incoming")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="outgoing">
        <MessageList
          messages={outgoingQuery.data?.messages ?? []}
          isLoading={outgoingQuery.isLoading}
          canRetry={true}
        />
      </TabsContent>
      <TabsContent value="incoming">
        <MessageList
          messages={incomingQuery.data?.messages ?? []}
          isLoading={incomingQuery.isLoading}
          canRetry={false}
        />
      </TabsContent>
    </Tabs>
  );
}
