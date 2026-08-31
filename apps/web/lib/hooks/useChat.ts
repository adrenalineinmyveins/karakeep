"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { useTRPC } from "@karakeep/shared-react/trpc";

// ── 类型定义 ──────────────────────────────────────────

export interface ToolCallInfo {
  toolName: string;
  status: "start" | "end";
  args?: unknown;
  result?: unknown;
}

export interface ChatMessageInfo {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallInfo[];
  pending?: boolean;
  /** 标记为失败的回复（用于下次输入时本地清理） */
  isError?: boolean;
}

// ── Hook ──────────────────────────────────────────────

export function useChat(sessionId: string | undefined) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  // 待发送内容，只有当用户点击发送后才设置并触发 subscription
  const [pendingInput, setPendingInput] = useState<string | null>(null);
  const msgIdCounter = useRef(0);

  const invalidateSessions = useCallback(() => {
    queryClient.invalidateQueries(
      api.chats.listSessions.pathFilter(),
    );
  }, [queryClient, api]);

  // ── 发送消息 ──────────────────────────────────────

  const sendMessage = useCallback(
    (content: string) => {
      if (!sessionId || !content.trim()) return;

      // 立即追加用户消息到 UI
      const userMsg: ChatMessageInfo = {
        id: `user-${msgIdCounter.current++}`,
        role: "user",
        content,
      };
      // 预占 assistant 消息位
      const assistantMsg: ChatMessageInfo = {
        id: `assistant-${msgIdCounter.current++}`,
        role: "assistant",
        content: "",
        toolCalls: [],
        pending: true,
      };
      setMessages((prev) => {
        // 上次失败留下的孤儿对话（旧 user + ❌ assistant）：
        // 本地移除，由后端 UPDATE 同步覆盖 DB。避免 UI 出现连续 user。
        if (prev.length >= 2) {
          const last = prev[prev.length - 1];
          const beforeLast = prev[prev.length - 2];
          if (last?.isError && beforeLast?.role === "user") {
            return [...prev.slice(0, -2), userMsg, assistantMsg];
          }
        }
        return [...prev, userMsg, assistantMsg];
      });
      setIsStreaming(true);
      setPendingInput(content);
    },
    [sessionId],
  );

  // ── 中止对话 ──────────────────────────────────────

  const abortMutation = useMutation(
    api.chats.abortSession.mutationOptions({
      onSuccess: () => {
        setIsStreaming(false);
        setPendingInput(null);
      },
    }),
  );

  const abort = useCallback(() => {
    if (!sessionId) return;
    abortMutation.mutate({ sessionId });
    // 立即更新 UI，不等网络返回
    setIsStreaming(false);
    setPendingInput(null);
    setMessages((prev) =>
      prev.map((m) =>
        m.pending ? { ...m, pending: false, content: m.content || "（已中断）" } : m,
      ),
    );
  }, [sessionId, abortMutation]);

  // ── 流式订阅 ──────────────────────────────────────

  useSubscription(
    api.chats.sendMessage.subscriptionOptions(
      { sessionId: sessionId!, content: pendingInput ?? "" },
      {
        enabled: !!sessionId && !!pendingInput,
        onData(event) {
          switch (event.type) {
            case "token_delta":
              setMessages((prev) =>
                prev.map((m, i) =>
                  i === prev.length - 1 && m.role === "assistant"
                    ? { ...m, content: m.content + event.delta }
                    : m,
                ),
              );
              break;

            case "tool_call":
              setMessages((prev) =>
                prev.map((m, i) => {
                  if (i !== prev.length - 1 || m.role !== "assistant") return m;
                  const toolCalls = [...(m.toolCalls ?? []), {
                    toolName: event.toolName,
                    status: event.status,
                    args: event.args,
                    result: event.result,
                  }];
                  return { ...m, toolCalls };
                }),
              );
              break;

            case "message_complete":
              setMessages((prev) =>
                prev.map((m, i) =>
                  i === prev.length - 1 && m.role === "assistant"
                    ? { ...m, content: event.content, pending: false }
                    : m,
                ),
              );
              break;

            case "agent_end":
              setIsStreaming(false);
              setPendingInput(null);
              setMessages((prev) =>
                prev.map((m) => (m.pending ? { ...m, pending: false } : m)),
              );
              invalidateSessions();
              break;

            case "error":
              setIsStreaming(false);
              setPendingInput(null);
              setMessages((prev) =>
                prev.map((m, i) =>
                  i === prev.length - 1 && m.role === "assistant"
                    ? {
                        ...m,
                        content: `❌ ${event.message}`,
                        pending: false,
                        isError: true,
                      }
                    : m,
                ),
              );
              break;
          }
        },
      },
    ),
  );

  // ── 加载历史消息 ──────────────────────────────────

  const loadHistory = useCallback(async () => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    const data = await queryClient.fetchQuery(
      api.chats.getSession.queryOptions({ sessionId }),
    );
    setMessages(
      data.messages.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    );
  }, [sessionId, queryClient, api]);

  return {
    messages,
    isStreaming,
    sendMessage,
    abort,
    loadHistory,
  };
}
