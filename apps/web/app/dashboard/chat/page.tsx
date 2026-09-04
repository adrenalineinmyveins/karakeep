"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import ChatPanel from "@/components/dashboard/chat/ChatPanel";
import ChatSessionList from "@/components/dashboard/chat/ChatSessionList";
import { useTRPC } from "@saiye/shared-react/trpc";

export default function ChatPageClient() {
  const [sessionId, setSessionId] = useState<string | undefined>();
  const api = useTRPC();
  const queryClient = useQueryClient();

  // 退出会话（切换/新建/离开页面）时自动总结对话并更新标题。
  // onSuccess 放在 mutationOptions 上，确保组件卸载后仍会刷新列表缓存。
  const generateTitle = useMutation(
    api.chats.generateTitle.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(api.chats.listSessions.pathFilter());
      },
    }),
  );

  const prevSessionIdRef = useRef<string | undefined>(undefined);

  // 切换或新建会话时，为上一个会话生成标题
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;
    if (prev && prev !== sessionId) {
      generateTitle.mutate({ sessionId: prev });
    }
  }, [sessionId]);

  // 离开 Chat 页面时，为当前会话生成标题
  useEffect(() => {
    return () => {
      const prev = prevSessionIdRef.current;
      if (prev) {
        generateTitle.mutate({ sessionId: prev });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-[calc(100vh-64px)]">
      <ChatSessionList currentSessionId={sessionId} onSelect={setSessionId} />
      <div className="flex-1">
        <ChatPanel sessionId={sessionId} onSessionCreated={setSessionId} />
      </div>
    </div>
  );
}
