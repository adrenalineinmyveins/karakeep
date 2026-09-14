"use client";

import { Bot, MessageCircle, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTRPC } from "@saiye/shared-react/trpc";

import { useChat } from "@/lib/hooks/useChat";
import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";

export default function ChatPanel({
  sessionId,
  onSessionCreated,
}: {
  sessionId: string | undefined;
  onSessionCreated: (id: string) => void;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  // 当前会话绑定的 agent 档案（loadHistory 的 fetchQuery 已写入同一缓存）
  const { data: sessionData } = useQuery(
    api.chats.getSession.queryOptions(
      { sessionId: sessionId! },
      { enabled: !!sessionId },
    ),
  );
  const { data: profileData } = useQuery(api.agentProfiles.list.queryOptions());
  const profiles = profileData?.profiles ?? [];
  const currentProfile = profiles.find(
    (p) => p.id === sessionData?.session.agentProfileId,
  );

  // CLI 型 agent 执行时间长：按档案超时放宽流空闲阈值
  // （服务端消息级超时 = timeoutMinutes*60s+30s，客户端再留 60s 余量）
  const idleTimeoutMs =
    currentProfile?.type === "trae-cli"
      ? currentProfile.timeoutMinutes * 60_000 + 90_000
      : undefined;

  const { messages, isStreaming, sendMessage, abort, loadHistory } = useChat(
    sessionId,
    idleTimeoutMs,
  );

  // 加载历史消息
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const scrollRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const createSession = useMutation(
    api.chats.createSession.mutationOptions({
      onSuccess: (session) => {
        onSessionCreated(session.id);
      },
    }),
  );

  const updateAgent = useMutation(
    api.chats.updateSessionAgent.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(api.chats.getSession.pathFilter());
        queryClient.invalidateQueries(api.chats.listSessions.pathFilter());
      },
    }),
  );

  const onAgentChange = (value: string) => {
    if (!sessionId) return;
    updateAgent.mutate({
      sessionId,
      agentProfileId: value === "default" ? null : value,
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* 顶部：agent 选择器 */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Bot size={16} className="shrink-0 text-muted-foreground" />
        <Select
          value={sessionData?.session.agentProfileId ?? "default"}
          onValueChange={onAgentChange}
          disabled={!sessionId || isStreaming || updateAgent.isPending}
        >
          <SelectTrigger className="h-8 w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">默认助手</SelectItem>
            {profiles.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 消息区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <MessageCircle size={40} className="opacity-30" />
            <p className="text-sm">
              开始对话，我可以帮你搜索书签、整理标签、收藏链接
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => createSession.mutate({})}
              disabled={createSession.isPending}
            >
              <Plus size={16} className="mr-1" />
              新建对话
            </Button>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
          </div>
        )}
      </div>

      {/* 输入区域 */}
      <ChatInput
        onSend={sendMessage}
        onAbort={abort}
        isStreaming={isStreaming}
        disabled={!sessionId}
      />
    </div>
  );
}
