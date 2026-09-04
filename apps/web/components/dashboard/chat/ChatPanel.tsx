"use client";

import { MessageCircle, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
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
  const { messages, isStreaming, sendMessage, abort, loadHistory } =
    useChat(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 加载历史消息
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

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

  return (
    <div className="flex h-full flex-col">
      {/* 消息区域 */}
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
